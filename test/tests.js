var assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    RSVP = require('rsvp'),
    unirest = require('unirest'),
    skeemas = require('skeemas'),
    git = require('git-utils'),
    debug = require('debug')('validator'),
    parallel = require('mocha.parallel');

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
      githubUsername:  { type: 'string', required: true, minLength: 2},
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

// azure cli apparently does not check for this
function validateTemplateParameters(templatePath, templateObject) {

  assert.ok(templateObject.parameters, 'Expected a \'.parameters\' field within the deployment template');
  for (var k in templateObject.parameters) {
    if(typeof k === 'string') {
      assert.ok(templateObject.parameters[k].metadata, 
        templatePath + ' - Template object .parameters.' + k + ' is missing its metadata field');
      assert.ok(templateObject.parameters[k].metadata.description, 
        templatePath + ' - Template object .paramters.' + k + '.description is missing');
    }
  }

}

function prepTemplate(templatePath, parametersPath) {
  var templateData = fs.readFileSync(templatePath, {encoding: 'utf-8'}),
      parameterData = fs.readFileSync(parametersPath, {encoding: 'utf-8'});

  templateData = templateData.trim();
  parameterData = parameterData.trim();

  var requestBody = {
    template: safeParse(templatePath, templateData),
    parameters: safeParse(templatePath, parameterData)
  }

  return requestBody;
}

// Calls a remote url which will validate the template and parameters
function validateTemplate(templatePath, parametersPath) {
  
  var requestBody = prepTemplate(templatePath, parametersPath);

  // validate the template paramters, particularly the description field
  validateTemplateParameters(templatePath, requestBody.template);

  return new RSVP.Promise(function(resolve, reject) {
    unirest.post(process.env.VALIDATION_HOST + '/validate')
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

// this is required to keep travis from timing out
// due to lack of console output
function timedOutput(onOff, intervalObject) {
  if (onOff) {
    return setInterval(function () {
      console.log('...');
    }, 30 * 1000)
  } else {
    clearTimeout(intervalObject);
  }
}

// Calls a remote url which will deploy the template
function deployTemplate(templatePath, parametersPath) {
  var requestBody = prepTemplate(templatePath, parametersPath);

  // validate the template paramters, particularly the description field
  validateTemplateParameters(templatePath, requestBody.template);

  var intervalObj = timedOutput(true);
  debug('making deploy request');

  return new RSVP.Promise(function(resolve, reject) {
    unirest.post(process.env.VALIDATION_HOST + '/deploy')
    .type('json')
    .timeout(3600 * 1000) // template deploy can take some time
    .send(JSON.stringify(requestBody))
    .end(function (response) {
      timedOutput(false, intervalObj);
      debug(response.status);
      debug(response.body);

      // 202 is the long poll response
      // anything else is really bad
      if (response.status !== 202) {
        return reject(response.body);
      }
      
      if(response.body.result === 'Deployment Successful') {
        return resolve(response.body);
      }
      else {
        return reject(response.body);
      }
      
    });
  });
}


function getDirectories(srcpath) {
  return fs.readdirSync(srcpath).filter(function(file) {
    return fs.statSync(path.join(srcpath, file)).isDirectory();
  });
}

// Generates the mocha tests based on directories in
// the existing repo.
function generateTests(modifiedPaths) {
  var tests = [];
  var directories = getDirectories('./');
  debug(modifiedPaths);
  var modifiedDirs = {};

  for (var k in modifiedPaths) {
    if (typeof k === 'string') {
      // don't include the top level dir
      if (path.dirname(k) === '.') {
        continue;
      }
      modifiedDirs[path.dirname(k)] = true;
    }
  }
  debug('modified dirs:');
  debug(modifiedDirs);
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
    if (modifiedPaths && !modifiedDirs[dirName]) {
      return;
    }

    tests.push({
      args: [templatePath, paramsPath, metadataPath],
      expected: true
    });
  });

  debug('created tests:');
  debug(tests);

  return tests;
}

// Group tests in chunks defined by an environment variable
// or by the default value
function groupTests (modifiedPaths) {
  // we probably shouldn't deploy a ton of templates at once...
  var tests = generateTests(modifiedPaths),
      testGroups = [],
      groupIndex = 0,
      counter = 0,
      groupSize = process.env.PARALLEL_DEPLOYMENT_NUMBER || 2;
  
  tests.forEach(function(test) {

    if (!testGroups[groupIndex]) {
      testGroups[groupIndex] = [];
    }

    testGroups[groupIndex].push(test);
    counter += 1;

    if (counter % groupSize === 0) {
      groupIndex += 1;
    }
  });

  return testGroups;
}

describe('Template', function() {

  this.timeout(3600 * 1000);

  var modifiedPaths;

  if (process.env.VALIDATE_MODIFIED_ONLY) {
    var repo = git.open('./');
    // we automatically reset to the beginning of the commit range
    // so this includes all file paths that have changed for the CI run
    modifiedPaths = repo.getStatus();
  }

  testGroups = groupTests(modifiedPaths);

  testGroups.forEach(function (tests) {
    parallel('Running ' + tests.length + ' Parallel Template Validation(s)...', function () {
      tests.forEach(function(test) {
        it(test.args[0] + ' & ' + test.args[1] + ' should be valid', function() {
          // validate template files are in correct place
          test.args.forEach(function (path) {
            var res = ensureExists.apply(null, [path]);
          });

          validateMetadata.apply(null, [test.args[2]]);

          return validateTemplate.apply(null, test.args)
          .then(function (result) {
            debug('template validation sucessful, deploying template...');
            return deployTemplate.apply(null, test.args);
          })
          .then(function () {
            // success
            return assert(true);
          })
          .catch(function (err) {
            var errorString = 'Template Validiation Failed. Try deploying your template with the commands:\n';
            errorString += 'azure group template validate --resource-group (your_group_name) ';
            errorString += ' --template-file ' + test.args[0] + ' --parameters-file ' + test.args[1] + '\n';
            errorString += 'azure group deployment create --resource-group (your_group_name) ';
            errorString += ' --template-file ' + test.args[0] + ' --parameters-file ' + test.args[1];
            assert(false, errorString + ' \n\nServer Error:' + JSON.stringify(err));
          });
        });
      });
    });
  });
});

