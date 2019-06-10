package main

import (
	"log"
	"os"

	docopt "github.com/docopt/docopt-go"
	"github.com/taskcluster/taskcluster-worker-runner/provider"
	"github.com/taskcluster/taskcluster-worker-runner/runner"
	"github.com/taskcluster/taskcluster-worker-runner/worker"
)

func usage() string {
	return `
start-worker starts Taskcluster workers.

Usage:
	start-worker <runnerConfig>

` + runner.Usage() + `

` + provider.Usage() + `

` + worker.Usage()
}

func main() {
	opts, err := docopt.Parse(usage(), nil, true, "start-worker", false, true)
	if err != nil {
		log.Printf("Error parsing command-line arguments: %s", err)
		os.Exit(1)
	}

	filename := opts["<runnerConfig>"].(string)
	log.Printf("Loading taskcluster-worker-runner configuration from %s", filename)
	runnercfg, err := runner.Load(filename)
	if err != nil {
		log.Printf("Error loading start-worker config: %s", err)
		os.Exit(1)
	}

	err = StartWorker(runnercfg)
	if err != nil {
		log.Printf("%s", err)
		os.Exit(1)
	}
}
