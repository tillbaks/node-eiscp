/*
    Converts eiscp-commands.yaml to eiscp-commands.json
*/
require('js-yaml');

var fs = require('fs'),
    command_mappings = {},
    value_mappings = {},
    command, value, doc,
    result = { "commands": {} };

try {

    doc = require('./eiscp-commands.yaml');

    for(var zone in doc) {
        if(zone === 'modelsets') {
            result.modelsets = doc.modelsets;
            continue;
        }
        result.commands[zone] = doc[zone];
        if(typeof command_mappings[zone] === 'undefined') {
            command_mappings[zone] = {};
            value_mappings[zone] = {};
        }
        for(var command in doc[zone]) {

            name = doc[zone][command].name;
            if(name instanceof Array) {
                for(var n in name) {
                    command_mappings[zone][name[n]] = command;
                }
            } else {
                command_mappings[zone][name] = command;
            }

            if(typeof value_mappings[zone][command] === 'undefined') {
                value_mappings[zone][command] = {};
            }
            for(var value in doc[zone][command].values) {
                name = doc[zone][command].values[value].name;
                if(typeof name !== 'undefined') {
                    if(name instanceof Array) {
                        for(var n in name) {
                            value_mappings[zone][command][name[n]] = value;
                        }
                    } else {
                        value_mappings[zone][command][name] = value;
                    }
                } else {
                    // Special values don't have names so we can handle them here
                    if(value.indexOf(",") !== -1) {
                        // It's a range
                        value_mappings[zone][command].__RANGE__ = value;
                    } else {
                        // It's not yet supported
                        console.log("Not yet supported: (command: " + command + ") (value: " + value + ") ( " + doc[zone][command].values[value].description + " )");
                    }
                }
            }
        }
    }

    result.command_mappings = command_mappings;
    result.value_mappings = value_mappings;

    fs.writeFile("eiscp-commands.json", JSON.stringify(result), function(err) {
        if(err) { return console.log(err); }

        console.log("eiscp-commands.json created!");
    });

} catch (e) {
    console.log(e);
}


/*,
var result = [];
result["NR509"] = [];

    for(var _set in doc.modelsets) {

        for(var _model in doc.modelsets[_set]) {
            if(doc.modelsets[_set][_model].indexOf("NR509") !== -1) {
                result['NR509'].push(_set);
            }
        }
    }

    console.log(result);
*/
