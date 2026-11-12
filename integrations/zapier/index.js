'use strict';

const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');

const { addApiKey, throwProblem } = require('./lib/api');
const authentication = require('./lib/authentication');
const { cancelJob, findJob, jobFinished, readPage, startReadJob } = require('./lib/actions');

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [throwProblem],
  triggers: { [jobFinished.key]: jobFinished },
  creates: { [readPage.key]: readPage, [startReadJob.key]: startReadJob, [cancelJob.key]: cancelJob },
  searches: { [findJob.key]: findJob },
};
