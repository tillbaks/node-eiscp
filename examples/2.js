var util = require('util'),
    eiscp = require('../eiscp');

/*
   Connect to receiver and send a command
   Disconnect when response is received
*/

// Will discover receiver automatically
eiscp.connect();
// Or connect to a specific IP
//eiscp.connect({host:"10.0.0.5"});

eiscp.on("debug", util.log);
eiscp.on("error", util.log);

// Please note that there is no way to identify who caused the volume to change
// You could just as well remove the eiscp.command (further down) and change the volume with the volume knob 
eiscp.on("data", function (result) {

    // We check if returned data contains the master-volume command and print the result
    if(typeof result.command !== 'undefined' && Array.isArray(result.command) && result.command[0] === 'master-volume') {
        console.log(util.format("\nReceived this data from receiver: %j\n", result));
        eiscp.close();
    }
});

eiscp.on('connect', function () {

    // Ask for power state
    //eiscp.command("system-power=query");

    // Set the volume to 22
    eiscp.command("volume=22");
});

