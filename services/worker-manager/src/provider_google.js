const slugid = require('slugid');
const _ = require('lodash');
const fs = require('fs');
const taskcluster = require('taskcluster-client');
const libUrls = require('taskcluster-lib-urls');
const uuid = require('uuid');
const {google} = require('googleapis');
const {Provider} = require('./provider');

class GoogleProvider extends Provider {

  constructor({
    name,
    taskclusterCredentials,
    monitor,
    estimator,
    notify,
    provisionerId,
    rootUrl,
    project,
    instancePermissions,
    creds,
    credsFile,
    validator,
    Worker,
  }) {
    super({name, taskclusterCredentials, monitor, notify, provisionerId, rootUrl, estimator, Worker, validator});
    this.configSchema = 'config-google';

    this.instancePermissions = instancePermissions;
    this.project = project;
    this.zonesByRegion = {};

    if (!creds && credsFile) {
      creds = JSON.parse(fs.readFileSync(credsFile));
    }
    try {
      creds = JSON.parse(creds);
    } catch (err) {
      if (err.name !== 'SyntaxError') {
        throw err;
      }
      creds = JSON.parse(Buffer.from(creds, 'base64'));
    }
    this.ownClientEmail = creds.client_email;
    const client = google.auth.fromJSON(creds);
    client.scopes = [
      'https://www.googleapis.com/auth/compute', // For configuring instance templates, groups, etc
      'https://www.googleapis.com/auth/iam', // For setting up service accounts for each workertype
      'https://www.googleapis.com/auth/cloud-platform', // To set roles for service accounts
    ];
    this.compute = google.compute({
      version: 'v1',
      auth: client,
    });
    this.iam = google.iam({
      version: 'v1',
      auth: client,
    });
    this.crm = google.cloudresourcemanager({
      version: 'v1',
      auth: client,
    });

    this.oauth2 = new google.auth.OAuth2();
  }

  /*
   * We will first set up a service account and role for each worker to use
   * since the default service account workers get is not very restricted
   */
  async initiate() {
    const accountId = 'taskcluster-workers';
    this.workerAccountEmail = `${accountId}@${this.project}.iam.gserviceaccount.com`;
    const accountRef = `projects/${this.project}/serviceAccounts/${this.workerAccountEmail}`;
    const roleId = 'taskcluster_workers';
    const roleName =`projects/${this.project}/roles/${roleId}`;

    // First we set up the service account
    await this.readModifySet({
      read: async () => (await this.iam.projects.serviceAccounts.get({
        name: accountRef,
      })).data,
      compare: () => true, // We do not modify this resource
      modify: () => {}, // Not needed due to no modifications
      set: async () => await this.iam.projects.serviceAccounts.create({
        name: `projects/${this.project}`,
        accountId,
        requestBody: {
          serviceAccount: {
            displayName: 'Taskcluster Workers',
            description: 'A service account shared by all Taskcluster workers.',
          },
        },
      }),
    });

    // Next we ensure that worker-manager can create instances with
    // this service account
    // If this is not the first time this has been set up, it will
    // simply overwrite the values in there now. This will undo manual changes.
    await this.iam.projects.serviceAccounts.setIamPolicy({
      resource: `projects/${this.project}/serviceAccounts/${this.workerAccountEmail}`,
      requestBody: {
        policy: {
          bindings: [{
            role: 'roles/iam.serviceAccountUser',
            members: [`serviceAccount:${this.ownClientEmail}`],
          }],
        },
      },
    });

    // Now we create a role or update it with whatever permissions we've configured
    // for this provider
    await this.readModifySet({
      read: async () => (await this.iam.projects.roles.get({
        name: roleName,
      })).data,
      compare: role => _.isEqual(role.includedPermissions, this.instancePermissions),
      modify: async role => {
        role.includedPermissions = this.instancePermissions;
        await this.iam.projects.roles.patch({
          name: roleName,
          updateMask: 'includedPermissions',
          requestBody: role,
        });
      },
      set: async () => this.iam.projects.roles.create({
        parent: `projects/${this.project}`,
        requestBody: {
          roleId,
          role: {
            title: 'Taskcluster Workers',
            description: 'Role shared by all Taskcluster workers.',
            includedPermissions: this.instancePermissions,
          },
        },
      }),
    });

    // Assign the role to the serviceAccount and we're good to go!
    const binding = {
      role: `projects/${this.project}/roles/${roleId}`,
      members: [`serviceAccount:${this.workerAccountEmail}`],
    };
    await this.readModifySet({
      read: async () => (await this.crm.projects.getIamPolicy({
        resource: this.project,
        requestBody: {},
      })).data,
      compare: policy => policy.bindings.some(b => _.isEqual(b, binding)),
      modify: async policy => {
        policy.bindings.push(binding);
        await this.crm.projects.setIamPolicy({
          resource: this.project,
          requestBody: {
            policy,
          },
        });
      },
    });
  }

  /**
   * Given a workerType and instance identity token from google, we return
   * taskcluster credentials for a worker to use if it is valid.
   *
   * All fields we check in the token are signed by google rather than the
   * requester so we know that they are not forged arbitrarily. Be careful
   * when selecting new fields to validate here, they may come from the requester.
   */
  async verifyIdToken({token, workerType}) {
    // This will throw an error if the token is invalid at all
    let {payload} = await this.oauth2.verifyIdToken({
      idToken: token,
      audience: this.rootUrl,
    });
    const dat = payload.google.compute_engine;

    // First check to see if the request is coming from the project this provider manages
    if (dat.project_id !== this.project) {
      const error = new Error(`Invalid project ${dat.project_id} is not ${this.project}`);
      error.project = dat.project_id;
      error.validProject = this.project;
      throw error;
    }

    // Now check to make sure that the serviceAccount that the worker has is the
    // serviceAccount that we have configured that worker to use. Nobody else in the project
    // should have permissions to create instances with this serviceAccount.
    if (payload.sub !== this.workerAccountEmail) {
      const error = new Error('Attempt to claim workertype creds from non-workertype instance');
      error.requestingAccountId = payload.sub;
      error.correctAccountId = this.workerAccountEmail;
      throw error;
    }

    // Google docs say instance id is globally unique even across projects
    const workerId = `gcp-${dat.instance_id}`;

    const worker = await this.Worker.load({
      workerType: workerType.name,
      workerId,
    }, true);

    // There will be no worker if either the workerId is not one we've made or if it is actually
    // from a different workerType since the load will not find it in that case
    if (!worker) {
      const error = new Error('Attempt to claim credentials from a non-existent worker');
      error.requestingId = workerId;
      throw error;
    }

    await worker.modify(w => {
      w.credentialed = true;
    });

    return taskcluster.createTemporaryCredentials({
      clientId: `worker/google/${this.project}/${dat.instance_id}`,
      scopes: [
        `assume:worker-type:${this.provisionerId}/${workerType.name}`,
        `assume:worker-id:${workerId}`,
      ],
      start: taskcluster.fromNow('-15 minutes'),
      expiry: taskcluster.fromNow('96 hours'),
      credentials: this.taskclusterCredentials,
    });
  }

  async provision({workerType}) {
    const regions = workerType.config.regions;
    const region = regions[Math.floor(Math.random() * regions.length)];
    if (!this.zonesByRegion[region]) {
      this.zonesByRegion[region] = (await this.compute.regions.get({
        project: this.project,
        region,
      })).data.zones;
    }
    const zones = this.zonesByRegion[region];
    const zone = zones[Math.floor(Math.random() * zones.length)].split('/').slice(-1)[0];

    // TODO: Use p-queue for all operations against google

    let op;

    try {
      op = await this.compute.instances.insert({
        project: this.project,
        zone,
        requestId: uuid.v4(), // This is just for idempotency
        requestBody: {
          name: `${workerType.name}-${slugid.nice()}`,
          labels: {
            workerType: workerType.name,
          },
          description: workerType.description,
          machineType: `zones/${zone}/machineTypes/${workerType.config.machineType}`,
          scheduling: workerType.config.scheduling,
          networkInterfaces: workerType.config.networkInterfaces,
          disks: workerType.config.disks,
          serviceAccounts: [{
            email: this.workerAccountEmail,
            scopes: [
              /*
               * This looks scary but is ok. According to
               * https://cloud.google.com/compute/docs/access/service-accounts#accesscopesiam
               *
               * "A best practice is to set the full cloud-platform
               * access scope on the instance, then securely limit
               * the service account's API access with IAM roles."
               *
               * Which is what we do.
               */
              'https://www.googleapis.com/auth/cloud-platform',
            ],
          }],
          metadata: {
            items: [
              {
                key: 'taskcluster',
                value: JSON.stringify({
                  provisionerId: this.provisionerId,
                  workerType: workerType.name,
                  workerGroup: `${workerType.name}-google`,
                  credentialUrl: libUrls.api(this.rootUrl, 'worker-manager', 'v1', `credentials/google/${workerType.name}`),
                  rootUrl: this.rootUrl,
                  userData: workerType.config.userData,
                }),
              },
            ],
          },
        },
      });
    } catch (err) {
      for (const error of err.errors) {
        await workerType.reportError({
          kind: 'creation-error',
          title: 'Instance Creation Error',
          description: error.message, // TODO: Make sure we clear exposing this with security folks
          notify: this.notify,
        });
      }
    }

    await this.Worker.create({
      workerType: workerType.name,
      provider: this.name,
      workerId: `gcp-${op.targetId}`,
      created: new Date(),
      credentialed: null,
    });

    await workerType.modify(wt => {
      wt.providerData[this.name].trackedOperations.push({
        region: op.region,
        name: op.name,
      });
    });

    await this.handleOperations({workerType});
  }

  /**
   * It is important that with the current design we only check on errors
   * for error reporting. We should not use it to gate further progress of
   * provisioning due to the fact that we might not succeed in recording
   * the operation when it actually suceeded.
   */
  async handleOperations({workerType}) {
    if (!workerType.providerData.trackedOperations) {
      return;
    }
    const ongoing = [];
    for (const op of workerType.providerData.trackedOperations) {
      const res = this.handleOperation({op, workerType});
      if (res) {
        ongoing.push(res);
      }
    }

    await workerType.modify(wt => {
      wt.providerData.trackedOperations = ongoing;
    });
  }

  async handleOperation({op, workerType}) {
    let operation;
    let getOp;
    let deleteOp;
    if (op.region) {
      const args = {
        project: this.project,
        region: op.region.split('/').slice(-1)[0],
        operation: op.name,
      };
      getOp = async () => this.compute.regionOperations.get(args);
      deleteOp = async () => this.compute.regionOperations.delete(args);
    } else {
      const args = {
        project: this.project,
        operation: op.name,
      };
      getOp = async () => this.compute.globalOperations.get(args);
      deleteOp = async () => this.compute.globalOperations.delete(args);
    }

    try {
      operation = (await getOp()).data;
    } catch (err) {
      if (err.code !== 404) {
        throw err;
      }
      // If the operation is no longer existing, nothing for us to do
      return null;
    }

    // Let's check back in on the next provisioning iteration if unfinished
    if (operation.status !== 'DONE') {
      return operation;
    }

    if (operation.error) {
      for (const err of operation.error.errors) { // Each operation can have multiple errors
        await workerType.reportError({
          kind: 'operation-error',
          title: 'Operation Error',
          description: err.message, // TODO: Make sure we clear exposing this with security folks
          extra: {
            code: err.code,
          },
          notify: this.notify,
        });
      }
    }
    await deleteOp();
  }

  /*
   * A useful wrapper for interacting with resources
   * that google wants you to use read-modify-set semantics with
   * Example: https://cloud.google.com/iam/docs/creating-custom-roles#read-modify-write
   */
  async readModifySet({
    compare,
    read,
    modify,
    set,
    tries = 0,
  }) {
    let resource;
    try {
      // First try to get the resource
      resource = await read();
    } catch (err) {
      if (err.code !== 404) {
        throw err;
      }
    }

    try {
      if (resource) {
        // If the value in google is different
        // from the one we want it to be, we try to update it
        if (!compare(resource)) {
          await modify(resource);
        }
      } else {
        // If the resource was never there in the first place, create it
        await set();
      }
    } catch (err) {
      if (err.code !== 409 && tries < 5) {
        throw err;
      }
      await new Promise(accept => setTimeout(accept, Math.pow(2, tries) * 100));
      await this.readModifySet({
        compare,
        read,
        modify,
        set,
        tries: tries++,
      });
    }
  }
}

module.exports = {
  GoogleProvider,
};
