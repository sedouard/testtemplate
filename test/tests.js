var assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    RSVP = require('rsvp'),
    unirest = require('unirest'),
    skeemas = require('skeemas');

// Tries to parse a json string and asserts with a friendly
// message if somerthign
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
      itemDisplayName: { type: 'string' },
      description: { type: 'string'},
      summary: { type: 'string'},
      githubUserName:  { type: 'string'},
      dateUpdated:  { type: 'string', required: true}
    },
    additionalProperties: false
  });
  var messages = '';
  result.errors.forEach(function (error){
    messages += ( metadataPath + ' - ' + error.context + ':' + error.message + '\n');
  });
  assert(result.valid, messages);
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

function generateTests() {
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

    tests.push({
      args: [path.join(dirName, 'azuredeploy.json'), path.join(dirName, 'azuredeploy.parameters.json'), path.join(dirName, 'metadata.json') ],
      expected: true
    });
  });

  return tests;
}

describe('Template', function() {

  this.timeout(20000);

  generateTests().forEach(function(test) {
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

