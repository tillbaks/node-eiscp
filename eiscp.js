/*jslint node:true nomen:true*/
"use strict";
var self, eiscp, send_queue, config,
    net = require('net'),
    dgram = require("dgram"),
    util = require('util'),
    async = require('async'),
    events = require('events'),
    STRINGS = require('./strings.json'),
    eiscp_commands = require('./eiscp-commands.json'),
    COMMANDS = eiscp_commands.commands,
    COMMAND_MAPPINGS = eiscp_commands.command_mappings,
    VALUE_MAPPINGS = eiscp_commands.value_mappings;

module.exports = self = new events.EventEmitter();

self.is_connected = false;

config = {
    "port": 60128,
    "reconnect": false,
    "reconnect_sleep": 5
};

function eiscp_packet(data, type) {
    /*
      Wraps command in eISCP packet for communicating over Ethernet
      type is device type where 1 is receiver and x is for the discovery broadcast
    */
    var iscp_msg = new Buffer("!" + (type || "1") + data + "\x0D\x0a"),
        header = new Buffer([
            73, 83, 67, 80, // magic
            0, 0, 0, 16,    // header size
            0, 0, 0, 0,     // data size
            1,              // version
            0, 0, 0         // reserved
        ]);

    // write data size to header
    header.writeUInt32BE(iscp_msg.length, 8);

    return Buffer.concat([
        header,
        iscp_msg
    ]);
}

function eiscp_packet_extract(packet) {
    /*
      Exracts message from eISCP packet
      Strip first 18 bytes and last 3 since that's only the header and end characters
    */
    return packet.toString('ascii', 18, packet.length - 3);
}

send_queue = async.queue(function (data, callback) {
    /*
      Syncronous queue which sends commands to device
    */
    if (self.is_connected) {
        self.emit("debug", util.format(STRINGS.sent_command, config.host, config.port, data));
        eiscp.write(eiscp_packet(data));
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

function iscp_to_command(iscp_message) {
    /*
      Transform a low-level ISCP message to a high-level command
    */
    var zone,
        command = iscp_message.slice(0, 3),
        args = iscp_message.slice(3);

    for (zone in COMMANDS) {

        if (typeof COMMANDS[zone][command] !== 'undefined') {
            if (typeof COMMANDS[zone][command].values[args] !== 'undefined') {
                return {
                    command: COMMANDS[zone][command].name,
                    argument: COMMANDS[zone][command].values[args].name
                };
            // TODO: Change to INTRANGES instead of __RANGE__:
            // "MVL":{"INTRANGES":[{"range":"0,100","models":"set9"},{"range":"0,80","models":"set10"}]}
            } else if (typeof VALUE_MAPPINGS[zone][command].INTRANGES !== 'undefined' && /^[0-9a-fA-F]+$/.exec(args)) {
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

function command_to_iscp(command, args, zone) {
    /*
      Transform high-level command to a low-level ISCP message
    */
    var base, parts, prefix, value,
        default_zone = 'main';

    function norm(s) {
        var i;
        if (Array.isArray(s)) {
            for (i in s) {
                s[i] = s[i].trim().toLowerCase();
            }
            return s;
        }
        return s.trim().toLowerCase();
    }

    function is_in_range(number, range) {
        var parts = range.split(",");
        number = parseInt(number, 10);
        return (parts.length === 2 && number >= parseInt(parts[0], 10) && number <= parseInt(parts[1], 10));
    }

    // If parts are not explicitly given, parse the command
    if (typeof args === 'undefined' && typeof zone === 'undefined') {
        // Separating command and args with colon allows multiple args
        if (command.indexOf(':') !== -1 || command.indexOf('=') !== -1) {

            base = command.split(/[:=]/, 1)[0];
            args = command.substr(base.length + 1);

            parts = base.split(/[. ]/);
            norm(parts);
            if (parts.length === 2) {
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
            if (parts.length >= 3) {

                zone = parts[0];
                command = parts[1];
                args = parts.slice(2);

            } else if (parts.length === 2) {

                zone = default_zone;
                command = parts[0];
                args = parts[1];

            } else {
                // Need at least command and argument
                self.emit("error", util.format(STRINGS.cmd_parse_error));
            }
        }
    }

    // Find the command in our database, resolve to internal eISCP command

    if (typeof COMMANDS[zone] === 'undefined') {
        self.emit("error", util.format(STRINGS.zone_not_exist, zone));
        return;
    }

    if (typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
        self.emit("error", util.format(STRINGS.cmd_not_exist, command, zone));
        return;
    }
    prefix = COMMAND_MAPPINGS[zone][command];

    if (typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {

        // TODO: Change to INTRANGES instead of __RANGE__:
        // "MVL":{"INTRANGES":[{"range":"0,100","models":"set9"},{"range":"0,80","models":"set10"}]}
        if (typeof VALUE_MAPPINGS[zone][prefix].INTRANGES !== 'undefined' && /^\d+$/.exec(args) && is_in_range(args, VALUE_MAPPINGS[zone][prefix].INTRANGES[0].range)) {
            // args is an integer and is in the available range for this command
            value = args;
            // Convert decimal number to hexadecimal since receiver doesn't understand decimal
            value = (+value).toString(16).toUpperCase();
            value = (value.length < 2) ? '0' + value : value;

        } else {

            self.emit("error", util.format(STRINGS.arg_not_exist, args, command));
            return;
        }

    } else {
        value = VALUE_MAPPINGS[zone][prefix][args].value;
    }

    return prefix + value;
}

self.discover = function () {
    /*
      discover([options, ] callback)
      Sends broadcast and waits for response callback called when number of devices or timeout reached
      option.devices  - stop listening after this amount of devices have answered (default: 1)
      option.timeout  - time in seconds to wait for devices to respond (default: 10)
      option.address  - broadcast address to send magic packet to (default: 255.255.255.255)
      option.port     - port to wait for response, you might have to change this is port 60128 (default) is already used
    */
    var options, callback, timeout_timer,
        provided_options = {},
        result = [],
        client = dgram.createSocket("udp4"),
        args = Array.prototype.slice.call(arguments),
        argv = args.length;

    if (argv === 1 && typeof args[0] === 'function') {
        callback = args[0];
    } else if (argv === 2 && typeof args[1] === 'function') {
        provided_options = args[0];
        callback = args[1];
    } else {
        return false;
    }

    options = {
        "devices":  (typeof provided_options.devices !== 'undefined')   ? provided_options.devices  : 1,
        "timeout":  (typeof provided_options.timeout !== 'undefined')   ? provided_options.timeout  : 10,
        "address":  (typeof provided_options.address !== 'undefined')   ? provided_options.address  : "255.255.255.255",
        "port":     (typeof provided_options.port !== 'undefined')      ? provided_options.port     : 60128
    };

    function close() {
        client.close();
        callback(result);
    }

    client.on("error", function (err) {
        self.emit("error", util.format(STRINGS.server_error, options.address, options.port, err));
        client.destroy();
    });

    client.on("message", function (packet, rinfo) {
        var message = eiscp_packet_extract(packet),
            command = message.slice(0, 3),
            data;
        if (command === "ECN") {
            data = message.slice(3).split("/");
            result.push({
                "host":     rinfo.address,
                "port":     data[1],
                "model":    data[0],
                "mac":      data[3],
                "areacode": data[2]
            });
            self.emit("debug", util.format(STRINGS.received_discovery, rinfo.address, rinfo.port, result));
            if (result.length >= options.devices) {
                clearTimeout(timeout_timer);
                close();
            }
        } else {
            self.emit("debug", util.format(STRINGS.received_data, rinfo.address, rinfo.port, message));
        }
    });

    client.on("listening", function () {
        client.setBroadcast(true);
        var buffer = eiscp_packet('ECNQSTN', 'x');
        self.emit("debug", util.format(STRINGS.sent_discovery, options.address, options.port));
        client.send(buffer, 0, buffer.length, options.port, options.address);
        timeout_timer = setTimeout(close, options.timeout * 1000);
    });
    client.bind(0);
};

self.connect = function (options) {
    /*
      No options required if you only have one receiver on your network. We will find it and connect to it!
      options.host            - Hostname/IP
      options.port            - Port (default: 60128)
      options.reconnect       - Try to reconnect if connection is lost (default: false)
      options.reconnect_sleep - Time in seconds to sleep between reconnection attempts (default: 5)
    */
    var connection_properties;
    if (typeof options !== 'undefined') {
        if (typeof options.host !== 'undefined') { config.host = options.host; }
        if (typeof options.port !== 'undefined') { config.port = options.port; }
        if (typeof options.reconnect !== 'undefined') { config.reconnect = options.reconnect; }
        if (typeof options.reconnect_sleep !== 'undefined') { config.reconnect_sleep = options.reconnect_sleep; }
    }

    // If no host is configured we connect to the first device to answer
    if (typeof config.host === 'undefined' || config.host === '') {
        self.discover({"all": false}, function (hosts) {
            if (hosts.length > 0) {
                self.connect(hosts[0]);
            }
            return;
        });
        return;
    }

    connection_properties = {
        host: config.host,
        port: config.port
    };

    self.emit("debug", util.format(STRINGS.connecting, config.host, config.port));

    if (typeof eiscp === 'undefined') {

        eiscp = net.connect(connection_properties);

        eiscp.on('connect', function () {

            self.is_connected = true;
            self.emit("debug", util.format(STRINGS.connected, config.host, config.port));
            self.emit('connect');
        });

        eiscp.on('close', function () {

            self.is_connected = false;
            self.emit("debug", util.format(STRINGS.disconnected, config.host, config.port));
            self.emit('close', false);

            if (config.reconnect) {

                setTimeout(self.connect, config.reconnect_sleep * 1000);
            }
        });

        eiscp.on('error', function (err) {

            self.emit("error", util.format(STRINGS.server_error, config.host, config.port, err));
            eiscp.destroy();
        });

        eiscp.on('data', function (data) {

            var iscp_message = eiscp_packet_extract(data),
                result = iscp_to_command(iscp_message);

            result.iscp_command = iscp_message;

            self.emit("debug", util.format(STRINGS.received_data, config.host, config.port, result));
            self.emit("data", result);
        });

        return;
    }
    eiscp.connect(connection_properties);
    return;
};

self.close = self.disconnect = function () {

    if (self.is_connected) {
        eiscp.destroy();
    }
};

self.raw = function (data, callback) {
    /*
      Send a low level command like PWR01
      callback only tells you that the command was sent but not that it succsessfully did what you asked
    */
    send_queue.push(data, function (result) {

        if (typeof callback === 'function') {

            callback(result);
        }
    });

};

self.command = function (data, callback) {
    /*
      Send a high level command like system-power=query
      callback only tells you that the command was sent but not that it succsessfully did what you asked
    */
    data = data.toLowerCase();
    data = command_to_iscp(data);

    self.raw(data, callback);
};

self.get_commands = function (zone, callback) {
    /*
      Returns all commands in given zone
    */
    var cmd, result = [];
    for (cmd in COMMAND_MAPPINGS[zone]) {
        result.push(cmd);
    }
    callback(result);
};

self.get_command = function (command, callback) {
    /*
      Returns all command values in given zone and command
    */
    var val, zone,
        result = [],
        parts = command.split(".");

    if (parts.length === 2) {
        zone = parts[0];
        command = parts[1];
    } else {
        zone = "main";
        command = parts[0];
    }

    for (val in VALUE_MAPPINGS[zone][COMMAND_MAPPINGS[zone][command]]) {
        result.push(val);
    }
    callback(result);
};
