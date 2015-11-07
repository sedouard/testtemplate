var assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    RSVP = require('rsvp'),
    unirest = require('unirest'),
    skeemas = require('skeemas'),
    git = require('git-utils');

// Tries to parse a json string and asserts with a friendly
// message if something is wrong
function safeParse (fileName, jsonStringData) {
  var object;

  try {
    object = JSON.parse(jsonStringData);
  } catch (e) {
    assert(false, fileName + ' is not valid JSON. Copy and paste the contents to https://jsonformatter.curiousconcept.com/ and correct the syntax errors. Error: ' + e.toString()) ;
  }

  return object;
}

// Vaidates that the expected file paths exist
function ensureExists (templatePath) {
  assert(fs.existsSync(templatePath), 'Expected ' + templatePath + ' to be in the correct place');
}

function validateMetadata(metadataPath) {
  var metadataData = fs.readFileSync(metadataPath, {encoding: 'utf-8'});
  metadataData = metadataData.trim();

  var metadata = safeParse(metadataPath, metadataData);

  var result = skeemas.validate(metadata,
  {
    properties: {
      itemDisplayName: { type: 'string', required: true, minLength: 10 },
      description: { type: 'string', required: true, minLength: 10},
      summary: { type: 'string', required: true, minLength: 10},
      githubUserName:  { type: 'string', required: true, minLength: 2},
      dateUpdated:  { type: 'string', required: true, minLength: 10}
    },
    additionalProperties: false
  });
  var messages = '';
  result.errors.forEach(function (error){
    messages += ( metadataPath + ' - ' + error.context + ':' + error.message + '\n');
  });
  assert(result.valid, messages);

  // validate date
  var date = new Date(metadata.dateUpdated);
  assert(!isNaN(date.getTime()), metadataPath + ' - dateUpdated field should be a valid date in the format YYYY-MM-DD');
}

// Calls a remote url which will validate the template and parameters
function validateTemplate(templatePath, parametersPath, validationUrl) {
  var templateData = fs.readFileSync(templatePath, {encoding: 'utf-8'}),
      parameterData = fs.readFileSync(parametersPath, {encoding: 'utf-8'});

  templateData = templateData.trim();
  parameterData = parameterData.trim();

  var requestBody = {
    template: safeParse(templatePath, templateData),
    parameters: safeParse(templatePath, parameterData)
  }

  return new RSVP.Promise(function(resolve, reject) {
    unirest.post(process.env.VALIDATION_URL)
    .type('json')
    .send(JSON.stringify(requestBody))
    .end(function (response) {

      if (response.status !== 200) {
        return reject(response.body);
      }

      return resolve(response.body);
    });
  });
}

function getDirectories(srcpath) {
  return fs.readdirSync(srcpath).filter(function(file) {
    return fs.statSync(path.join(srcpath, file)).isDirectory();
  });
}

function generateTests(modifiedPaths) {
  var tests = [];
  var directories = getDirectories('./');
  
  directories.forEach(function (dirName) {


    // exceptions
    if (dirName === '.git' ||
        dirName === 'node_modules') {
      return;
    }

    if (fs.existsSync(path.join(dirName, '.ci_skip'))) {
      return;
    }
    var templatePath = path.join(dirName, 'azuredeploy.json'),
        paramsPath = path.join(dirName, 'azuredeploy.parameters.json'),
        metadataPath = path.join(dirName, 'metadata.json');

    // if we are only validating modified templates
    // only add test if this directory template has been modified
    if (modifiedPaths && (!modifiedPaths[templatePath] && !modifiedPaths[paramsPath]
      && modifiedPaths[metadataPath]) === undefined) {
      return;
    }

    tests.push({
      args: [templatePath, paramsPath, metadataPath],
      expected: true
    });
  });

  return tests;
}

describe('Template', function() {

  this.timeout(20000);

  var modifiedPaths;

  if (process.env.VALIDATE_MODIFIED_ONLY) {
    var repo = git.open('./');
    // we automatically reset to the beginning of the commit range
    // so this includes all file paths that have changed for the CI run
    modifiedPaths = repo.getStatus();
    console.log(modifiedPaths);
  }

  generateTests(modifiedPaths).forEach(function(test) {

    it(test.args[0] + ' & ' + test.args[1] + ' should be valid', function() {
      // validate template files are in correct place
      test.args.forEach(function (path) {
        var res = ensureExists.apply(null, [path]);
      });
      
      validateMetadata.apply(null, [test.args[2]]);

      return validateTemplate.apply(null, test.args)
      .then(function (result) {
        assert.equal(true, true);
      })
      .catch(function (err) {
        throw err;
      });
    });
  });
});

