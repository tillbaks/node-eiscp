var util = require('util'),
    eiscp = require('../eiscp');


// Discover all receviers on network

eiscp.discover({}, function(res){

    console.log(res);
});

