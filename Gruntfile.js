var grunt = require('grunt');
require('load-grunt-tasks')(grunt);

grunt.initConfig({
    mochacli: {
        options: {
            reporter: 'spec',
            bail: false
        },
        all: ['test/*.js']
    }
});
grunt.registerTask('test', ['mochacli']);
