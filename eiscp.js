var net = require('net'),
    dgram = require("dgram"),
    util = require('util'),
    async = require('async'),
    events = require('events'),
    STRINGS = require('./strings.json'),
    eiscp_commands = require('./eiscp-commands.json'),
    COMMANDS = eiscp_commands.commands,
    COMMAND_MAPPINGS = eiscp_commands.command_mappings,
    VALUE_MAPPINGS = eiscp_commands.value_mappings;

function eISCP() {

    var self = this,
        eiscp, send_queue;

    self.is_connected = false;
    self.config = {
        "port": 60128,
        "reconnect": true,
        "reconnect_sleep": 5
    };

    // No options required if you only have one receiver on your network. We will find it and connect to it!
    // options.host            - Hostname/IP
    // options.port            - Port (default: 60128)
    // options.reconnect       - Try to reconnect if connection is lost (default: true)
    // options.reconnect_sleep - Time in seconds to sleep between reconnection attempts (default: 5)
    self.connect = function(options) {

        var connection_properties;

        if(typeof options !== 'undefined') {
            if(typeof options.host !== 'undefined') { self.config.host = options.host; }
            if(typeof options.port !== 'undefined') { self.config.port = options.port; }
            if(typeof options.reconnect !== 'undefined') { self.config.reconnect = options.reconnect; }
            if(typeof options.reconnect_sleep !== 'undefined') { self.config.reconnect_sleep = options.reconnect_sleep; }
        }

        // If no host is configured we connect to the first device to answer
        if(typeof self.config.host === 'undefined' || self.config.host === '') {
            self.discover({"all": false}, function (hosts) {
                if(hosts.length > 0) {
                    self.connect(hosts[0]);
                }
                return;
            });
            return;
        }

        connection_properties = {"host": self.config.host, "port": self.config.port};

        self.emit("debug", util.format(STRINGS.connecting, self.config.host, self.config.port));

        if (typeof eiscp === 'undefined') {

            eiscp = net.connect(connection_properties);

            eiscp.on('connect', function() {

                self.is_connected = true;
                self.emit("debug", util.format(STRINGS.connected, self.config.host, self.config.port));
                self.emit('connect');
            });

            eiscp.on('close', function() {

                self.is_connected = false;
                self.emit("debug", util.format(STRINGS.disconnected, self.config.host, self.config.port));
                self.emit('close', false);

                if (self.config.reconnect) {

                    setTimeout(self.connect, self.config.reconnect_sleep * 1000);
                }
            });

            eiscp.on('error', function(err) {

                self.emit("error", util.format(STRINGS.server_error, self.config.host, self.config.port, err));
                eiscp.close();
            });

            eiscp.on('data', function (data) {

                var iscp_message = eiscp_extract(data.toString()),
                    result = iscp_to_command(iscp_message);

                result.iscp_command = iscp_message;

                self.emit("debug", util.format(STRINGS.received_data, self.config.host, self.config.port, result));
                self.emit("data", result);
            });

            return;
        }
        eiscp.connect(connection_properties);
        return;
    };

    // Sends broadcast and waits for response for 2 seconds
    // option.timeout  - time in seconds to wait for devices to respond (default: 2)
    // option.address  - broadcast address to send magic packet to (default: 255.255.255.255)
    // option.port     - port to wait for response, you might have to change this is port 60128 is already used
    self.discover = function (options, callback) {

        var result = [],
            client = dgram.createSocket("udp4");

        options = {
            "timeout": options.timeout || 2,
            "address": options.address || "255.255.255.255",
            "port": options.port || 60128
        };

        client.on("error", function (err) {
            self.emit("error", util.format(STRINGS.server_error, options.address, options.port, err));
            client.close();
        });
        client.on("message", function (packet, rinfo) {
            var message = eiscp_extract(packet.toString()),
                command = message.slice(0,3),
                data;
            if(command === "ECN") {
                data = message.slice(3).split("/");
                result.push({
                    "host":     rinfo.address,
                    "port":     data[1],
                    "model":    data[0],
                    "mac":      data[3],
                    "areacode": data[2],
                    "message":  message
                });
                self.emit("debug", util.format(STRINGS.received_discovery, rinfo.address, rinfo.port, result));
            } else {
                self.emit("debug", util.format(STRINGS.received_data, rinfo.address, rinfo.port, message));
            }
        });
        client.on("listening", function () {
            client.setBroadcast(true);
            var buffer = new Buffer(eISCPPacket('!xECNQSTN'));
            self.emit("debug", util.format(STRINGS.sent_discovery, options.address, options.port, "!xECNQSTN"));
            client.send(buffer, 0, buffer.length, options.port, options.address);
            setTimeout(function () {
                client.close();
                callback(result);
            }, options.timeout * 1000);
        });
        client.bind(0);
    };

    // Send a low level command like PWR01
    // callback only tells you that the command was sent but not that it succsessfully did what you asked
    self.raw = function(data, callback) {

        send_queue.push(data, function(result) {

            if (typeof callback === 'function') {

                callback(result);
            }
        });

    };

    // Send a high level command like system-power=query
    // callback only tells you that the command was sent but not that it succsessfully did what you asked
    self.command = function(data, callback) {

        data = data.toLowerCase();
        data = command_to_iscp(data);

        self.raw(data, callback);
    };

    // Wraps data in ISCP container
    function ISCPMessage (data) {
        // ! = start character
        // 1 = destination (1 = receiver)
        // \x0D = end character (carriage return)

        return "!1" + data + "\x0D";
    }

    // Wraps ISCP message in eISCP packet for communicating over Ethernet
    function eISCPPacket (data) {

        return [
            "ISCP",                             // magic
            "\x00\x00\x00\x10\x00\x00\x00",     // ? no clue
            (+(data.length+3)).toString(16),    // data length in hex
            "\x01",                             // version
            "\x00\x00\x00",                     // reserved
            data
        ].join('');
    }

    // Exracts message from eISCP packet
    function eiscp_extract (packet) {
        var message, begin, end = -1;

        begin = packet.indexOf("!1") + 2;
        // TODO: I've been getting some different end character so I'm just trying them all...
        if(packet.indexOf("\r") != -1) { end = packet.indexOf("\r") }
        else if(packet.indexOf("\u001a") != -1) { end = packet.indexOf("\u001a") }
        else if(packet.indexOf("\u0019") != -1) { end = packet.indexOf("\u0019") }

        message = packet.slice(begin, end - 1);

        return message;
    }

    // Queue which sends commands to device
    send_queue = async.queue(function(data, callback) {

        var packet;

        if (self.is_connected) {
            packet = eISCPPacket(ISCPMessage(data));

            self.emit("debug", util.format(STRINGS.sent_command, self.config.host, self.config.port, data, packet));
            eiscp.write(packet);
            if (typeof callback === 'function') {
                callback({ "result": true, "msg": "" });
            }
            return;
        }

        self.emit("error", util.format(STRINGS.send_not_connected, data));
        if (typeof callback === 'function') {
            callback({ "result": false, "msg": "" });
        }

    }, 1);

    // Transform a low-level ISCP message to a high-level command
    function iscp_to_command (iscp_message) {
        var command = iscp_message.slice(0,3),
            args = iscp_message.slice(3);

        for(var zone in COMMANDS) {

            if(typeof COMMANDS[zone][command] !== 'undefined') {
                if(typeof COMMANDS[zone][command].values[args] !== 'undefined') {
                    return {
                        command: COMMANDS[zone][command].name,
                        argument: COMMANDS[zone][command].values[args].name
                    };
                } else if(typeof VALUE_MAPPINGS[zone][command].__RANGE__ !== 'undefined' && /^[0-9a-fA-F]+$/.exec(args)) {
                    // It's a range so we need to convert args to decimal
                    return {
                        command: COMMANDS[zone][command].name,
                        argument: parseInt(args, 16)
                    };
                }
            }
        }

        return {};
    }

    // Transform high-level command to a low-level ISCP message
    function command_to_iscp (command, args, zone) {

        var default_zone = 'main',
            base, parts, prefix, value;

        function norm (s) {
            if(Array.isArray(s)) {
                for(var i in s) {
                    s[i] = s[i].trim().toLowerCase();
                }
                return s;
            }
            return s.trim().toLowerCase();
        }

        function is_in_range(number, range) {
            var parts = range.split(",");
            number = parseInt(number, 10);
            return (parts.length === 2 && number >= parseInt(parts[0],10) && number <= parseInt(parts[1],10));
        }

        // If parts are not explicitly given, parse the command
        if(typeof args === 'undefined' && typeof zone === 'undefined') {
            // Separating command and args with colon allows multiple args
            if(command.indexOf(':') !== -1 || command.indexOf('=') !== -1) {

                base = command.split(/[:=]/,1)[0];
                args = command.substr(base.length+1);

                parts = base.split(/[. ]/);
                norm(parts);
                if(parts.length == 2) {
                    zone = parts[0];
                    command = parts[1];
                } else {
                    zone = default_zone;
                    command = parts[0];
                }

                // Split arguments by comma or space
                args = args.split(/[ ,]/);
                norm(args);

            } else {

                // Split command part by space or dot

                parts = command.split(/[. ]/);
                norm(parts);
                if(parts.length >= 3) {

                    zone = parts[0];
                    command = parts[1];
                    args = parts.slice(2);

                } else if(parts.length == 2) {

                    zone = default_zone;
                    command = parts[0];
                    args = parts[1];

                } else {

                    // Need at least command and argument
                }
            }
        }

        // Find the command in our database, resolve to internal eISCP command

        if(typeof COMMANDS[zone] === 'undefined') {
            self.emit("error", util.format(STRINGS.zone_not_exist, zone));
            return;
        }

        if(typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
            self.emit("error", util.format(STRINGS.cmd_not_exist, command, zone));
            return;
        }
        prefix = COMMAND_MAPPINGS[zone][command];

        if(typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {

            if(typeof VALUE_MAPPINGS[zone][prefix].__RANGE__ !== 'undefined' && /^\d+$/.exec(args) && is_in_range(args, VALUE_MAPPINGS[zone][prefix].__RANGE__)) {
                // args is an integer and is in the available range for this command
                value = args;
                // Convert decimal number to hexadecimal since receiver doesn't understand decimal
                value = (+value).toString(16).toUpperCase();
                value = (value.length < 2) ? '0'+value : value;

            } else {

                self.emit("error", util.format(STRINGS.arg_not_exist, args, command));
                return;
            }

        } else {
            value = VALUE_MAPPINGS[zone][prefix][args];
        }

        return prefix + value;
    }

    // Returns all commands in given zone
    self.get_commands = function (zone, callback) {
        var result = [];
        for(var cmd in COMMAND_MAPPINGS[zone]) {
            result.push(cmd);
        }
        callback(result);
    };

    // Returns all command values in given zone and command
    self.get_command = function (command, callback) {
        var result = [],
            parts = command.split("."),
            zone;

        if(parts.length === 2) {
            zone = parts[0];
            command = parts[1];
        } else {
            zone = "main";
            command = parts[0];
        }

        for(var val in VALUE_MAPPINGS[zone][COMMAND_MAPPINGS[zone][command]]) {
            result.push(val);
        }
        callback(result);
    };
}
util.inherits(eISCP, events.EventEmitter);

module.exports = new eISCP();