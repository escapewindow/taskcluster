const fs = require('fs');
const {google} = require('googleapis');
const {Provider} = require('./provider');

class GoogleProvider extends Provider {

  constructor({id, monitor, notify, project, credsFile}) {
    super({id, monitor, notify});

    this.project = project;

    // TODO: Just have it passed in from env instead of reading from a file
    const client = google.auth.fromJSON(JSON.parse(fs.readFileSync(credsFile)));
    client.scopes = [
      'https://www.googleapis.com/auth/compute', // For configuring instance templates, groups, etc
      'https://www.googleapis.com/auth/iam', // For setting up service accounts for each workertype
      'https://www.googleapis.com/auth/cloud-platform', // To set roles for service accounts
    ];
    this.compute = google.compute({
      version: 'v1',
      auth: client,
    });
  }

  async initiate() {
  }

  async terminate() {
  }

  async listWorkers({states, workerTypes}) {
    throw new Error('Method Unimplemented!');
  }

  async queryWorkerState({workerId}) {
    throw new Error('Method Unimplemented!');
  }

  workerInfo({worker}) {
    throw new Error('Method Unimplemented!');
  }

  async prepare() {
    // TODO: I don't think there's anyhting to do here
  }

  async provision({workerType}) {
    // TODO: Remove the hardcoding
    await workerType.modify(wt => {
      wt.config = {
        image: 'generic-worker-test-1',
      };
    });

    if (!await this.ensureImage({workerType})) {
      return;
    }
    const account = await this.configureServiceAccount({workerType});
    //const role = await this.configureRole(workerType);
    //await this.configurePolicies({account, role});
    //const template = await this.setupTemplate({workerType, account});
  }

  async cleanup() {
    // Here we will list all templates that this provider has created
    // and remove any that weren't called in the provisioning loop
  }

  async terminateAllWorkers() {
    throw new Error('Method Unimplemented!');
  }

  async terminateWorkerType({workerType}) {
    throw new Error('Method Unimplemented!');
  }

  async terminateWorkers({workers}) {
    throw new Error('Method Unimplemented!');
  }

  async ensureImage({workerType}) {
    try {
      await this.compute.images.get({
        project: this.project,
        image: workerType.config.image,
      });
    } catch (err) {
      if (err.code !== 404) {
        throw err;
      }
      await workerType.reportError({
        type: 'unknown-image',
        title: 'Unknown Image',
        description: 'Image does not exist in project. Possibly the image was generated in a different project?',
        extra: {
          image: workerType.config.image,
          project: this.project,
        },
        notify: this.notify,
        owner: workerType.owner,
      });
      return false;
    }
    return true;
  }

  async configureServiceAccount({workerType}) {
    console.log(workerType);
  }

}

module.exports = {
  GoogleProvider,
};
