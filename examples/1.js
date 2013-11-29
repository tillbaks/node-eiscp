var util = require('util'),
    eiscp = require('../eiscp');

eiscp.on('debug', util.log);
eiscp.on('error', util.log);

// Discover all receviers on network

eiscp.discover(function(res){

    console.log(res);
});

