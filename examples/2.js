var util = require('util'),
    eiscp = require('../eiscp');


// Connect to receiver and send a command
// Disconnect when response is received

eiscp.connect({reconnect: false});

eiscp.on("debug", util.log);
eiscp.on("error", util.log);
eiscp.on("data", function (result) {

    console.log(util.format("\nReceived this data from receiver: %j\n", result));
    eiscp.close();
});

eiscp.on('connect', function () {
    eiscp.command("volume=22");
});

