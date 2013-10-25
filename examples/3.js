var util = require('util'),
    eiscp = require('../eiscp');


// This will output a list of available commands

eiscp.get_commands("main", function(cmds) {

    //console.log(cmds);
    for(var cmd in cmds) {
        console.log(cmds[cmd])
        eiscp.get_command(cmds[cmd], function (values) {
            console.log(values);
        });
    }
});

