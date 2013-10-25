var util = require('util'),
    eiscp = require('../eiscp');


// Connect to receiver and send a command

eiscp.connect();

eiscp.on("debug", util.log);
eiscp.on("error", util.log);
eiscp.on("data", function (result) {

    console.log(
        "Received data from receiver:" + util.format("%j", result)
    );
});

eiscp.on('connect', function () {
    eiscp.command("volume=22");
});

