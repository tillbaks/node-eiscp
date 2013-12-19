/*jslint node:true nomen:true*/
'use strict';
var self, eiscp, send_queue,
    net = require('net'),
    dgram = require('dgram'),
    util = require('util'),
    async = require('async'),
    events = require('events'),
    STRINGS = require('./strings.json'),
    eiscp_commands = require('./eiscp-commands.json'),
    COMMANDS = eiscp_commands.commands,
    COMMAND_MAPPINGS = eiscp_commands.command_mappings,
    VALUE_MAPPINGS = eiscp_commands.value_mappings,
    MODELSETS = eiscp_commands.modelsets,
    config = { port: 60128, reconnect: false, reconnect_sleep: 5, modelsets: [] };

module.exports = self = new events.EventEmitter();

self.is_connected = false;

function in_modelsets(set) {
    // returns true if set is in modelsets false otherwise
    return (config.modelsets.indexOf(set) !== -1);
}

function set_modelsets() {
    /*
      Finds all modelsets that contain provided model
      Note that this is not an exact match, model only has to be part of the modelname
    */
    Object.keys(MODELSETS).forEach(function (set) {
        MODELSETS[set].forEach(function (models) {
            if (models.indexOf(config.model) !== -1) {
                config.modelsets.push(set);
            }
        });
    });
    return;
}

function eiscp_packet(data) {
    /*
      Wraps command or iscp message in eISCP packet for communicating over Ethernet
      type is device type where 1 is receiver and x is for the discovery broadcast
      Returns complete eISCP packet as a buffer ready to be sent
    */
    var iscp_msg, header;
    // Add ISCP header if not already present
    if (data.charAt(0) !== '!') { data = '!1' + data; }
    // ISCP message
    iscp_msg = new Buffer(data + '\x0D\x0a');
    // eISCP header
    header = new Buffer([
        73, 83, 67, 80, // magic
        0, 0, 0, 16,    // header size
        0, 0, 0, 0,     // data size
        1,              // version
        0, 0, 0         // reserved
    ]);
    // write data size to eISCP header
    header.writeUInt32BE(iscp_msg.length, 8);

    return Buffer.concat([header, iscp_msg]);
}

function eiscp_packet_extract(packet) {
    /*
      Exracts message from eISCP packet
      Strip first 18 bytes and last 3 since that's only the header and end characters
    */
    return packet.toString('ascii', 18, packet.length - 3);
}

function iscp_to_command(iscp_message) {
    /*
      Transform a low-level ISCP message to a high-level command
    */
    var command = iscp_message.slice(0, 3),
        value = iscp_message.slice(3),
        result = {};

    Object.keys(COMMANDS).forEach(function (zone) {

        if (typeof COMMANDS[zone][command] !== 'undefined') {

            var zone_cmd = COMMANDS[zone][command];

            result.command = zone_cmd.name;

            if (typeof zone_cmd.values[value] !== 'undefined') {

                result.argument = zone_cmd.values[value].name;

            } else if (typeof VALUE_MAPPINGS[zone][command].INTRANGES !== 'undefined' && /^[0-9a-fA-F]+$/.test(value)) {

                // It's a range so we need to convert args from hex to decimal
                result.argument = parseInt(value, 16);
            }
        }
    });

    return result;
}

// TODO: This function is starting to get very big, it should be split up into smaller parts and oranized better
function command_to_iscp(command, args, zone) {
    /*
      Transform high-level command to a low-level ISCP message
    */
    var base, parts, prefix, value, i, len, intranges,
        default_zone = 'main';

    self.emit('debug', util.format('DEBUG (command_to_iscp) Command: %s | Args: %s | Zone: %s', command, args, zone));

    function norm(data) {
        // trims, lowercasees and removes empty array elements
        var i, len, result = [];
        if (Array.isArray(data)) {
            len = data.length;
            for (i = 0; i < len; i += 1) {
                if (data[i].trim() !== '') {
                    result.push(data[i].trim().toLowerCase());
                }
            }
            return result;
        }
        return data.trim().toLowerCase();
    }

    function in_intrange(number, range) {
        var parts = range.split(',');
        number = parseInt(number, 10);
        return (parts.length === 2 && number >= parseInt(parts[0], 10) && number <= parseInt(parts[1], 10));
    }

    // If parts are not explicitly given, parse the command
    if (typeof args === 'undefined' && typeof zone === 'undefined') {
        // Separating command and args with colon allows multiple args
        if (command.indexOf(':') !== -1 || command.indexOf('=') !== -1) {

            base = command.split(/[:=]/, 1)[0];
            args = command.substr(base.length + 1);

            parts = norm(base).split(/[. ]/);
            parts = norm(parts);
            if (parts.length === 2) {
                zone = parts[0];
                command = parts[1];
            } else {
                zone = default_zone;
                command = parts[0];
            }

            // Split arguments by comma or space
            args = norm(args).split(/[, ]/);
            args = norm(args);

        } else {

            // Split command part by space or dot
            parts = command.split(/[. ]/);
console.log(parts);
            parts = norm(parts);
console.log(parts);
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
                self.emit('error', util.format(STRINGS.cmd_parse_error));
                return;
            }
        }
    }

    // Find the command in our database, resolve to internal eISCP command

    if (typeof COMMANDS[zone] === 'undefined') {
        self.emit('error', util.format(STRINGS.zone_not_exist, zone));
        return;
    }

    if (typeof COMMAND_MAPPINGS[zone][command] === 'undefined') {
        self.emit('error', util.format(STRINGS.cmd_not_exist, command, zone));
        return;
    }
    prefix = COMMAND_MAPPINGS[zone][command];

    if (typeof VALUE_MAPPINGS[zone][prefix][args] === 'undefined') {

        if (typeof VALUE_MAPPINGS[zone][prefix].INTRANGES !== 'undefined' && /^\d+$/.test(args)) {
            // This command is part of a integer range
            intranges = VALUE_MAPPINGS[zone][prefix].INTRANGES;
            len = intranges.length;

            for (i = 0; i < len; i += 1) {
                if (in_modelsets(intranges[i].models) && in_intrange(args, intranges[i].range)) {
                    // args is an integer and is in the available range for this command
                    value = args;
                }
            }

            if (typeof value === 'undefined') {
                self.emit('error', util.format(STRINGS.arg_not_exist, args, command));
                return;
            }

            // Convert decimal number to hexadecimal since receiver doesn't understand decimal
            value = (+value).toString(16).toUpperCase();
            value = (value.length < 2) ? '0' + value : value;

        } else {

            // Not yet supported command
            self.emit('error', util.format(STRINGS.arg_not_exist, args, command));
            return;
        }

    } else {

        // Check if the commands modelset is in the receviers modelsets
        if (in_modelsets(VALUE_MAPPINGS[zone][prefix][args].models)) {
            value = VALUE_MAPPINGS[zone][prefix][args].value;
        } else {
            self.emit('error', util.format(STRINGS.cmd_not_supported, command, zone));
            return;
        }
    }

    return prefix + value;
}

self.discover = function () {
    /*
      discover([options, ] callback)
      Sends broadcast and waits for response callback called when number of devices or timeout reached
      option.devices    - stop listening after this amount of devices have answered (default: 1)
      option.timeout    - time in seconds to wait for devices to respond (default: 10)
      option.address    - broadcast address to send magic packet to (default: 255.255.255.255)
      option.port       - receiver port should always be 60128 this is just available if you need it
    */
    var callback, timeout_timer,
        options = {},
        provided_options = {},
        result = [],
        client = dgram.createSocket('udp4'),
        argv = Array.prototype.slice.call(arguments),
        argc = argv.length;

    if (argc === 1 && typeof argv[0] === 'function') {
        callback = argv[0];
    } else if (argc === 2 && typeof argv[1] === 'function') {
        provided_options = argv[0];
        callback = argv[1];
    } else {
        return false;
    }

    options.devices = provided_options.devices || 1;
    options.timeout = provided_options.timeout || 10;
    options.address = provided_options.address || '255.255.255.255';
    options.port = provided_options.port || 60128;

    function close() {
        client.close();
        callback(result);
    }

    client.on('error', function (err) {
        self.emit('error', util.format(STRINGS.server_error, options.address, options.port, err));
        client.destroy();
    });

    client.on('message', function (packet, rinfo) {
        var message = eiscp_packet_extract(packet),
            command = message.slice(0, 3),
            data;
        if (command === 'ECN') {
            data = message.slice(3).split('/');
            result.push({
                host:     rinfo.address,
                port:     data[1],
                model:    data[0],
                mac:      data[3].slice(0, 12), // There's lots of null chars after MAC so we slice them off
                areacode: data[2]
            });
            self.emit('debug', util.format(STRINGS.received_discovery, rinfo.address, rinfo.port, result));
            if (result.length >= options.devices) {
                clearTimeout(timeout_timer);
                close();
            }
        } else {
            self.emit('debug', util.format(STRINGS.received_data, rinfo.address, rinfo.port, message));
        }
    });

    client.on('listening', function () {
        client.setBroadcast(true);
        var buffer = eiscp_packet('!xECNQSTN');
        self.emit('debug', util.format(STRINGS.sent_discovery, options.address, options.port));
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
      options.model           - Should be discovered automatically but if you want to override it you can
      options.reconnect       - Try to reconnect if connection is lost (default: false)
      options.reconnect_sleep - Time in seconds to sleep between reconnection attempts (default: 5)
    */
    var connection_properties;
    if (typeof options !== 'undefined') {
        if (typeof options.host !== 'undefined') { config.host = options.host; }
        if (typeof options.port !== 'undefined') { config.port = options.port; }
        if (typeof options.model !== 'undefined') { config.model = options.model; }
        if (typeof options.reconnect !== 'undefined') { config.reconnect = options.reconnect; }
        if (typeof options.reconnect_sleep !== 'undefined') { config.reconnect_sleep = options.reconnect_sleep; }
    }
    connection_properties = {
        host: config.host,
        port: config.port
    };

    // If no host is configured - we connect to the first device to answer
    if (typeof config.host === 'undefined' || config.host === '') {
        self.discover(function (hosts) {
            if (hosts.length > 0) {
                self.connect(hosts[0]);
            }
            return;
        });
        return;
    }

    // If host is configured but no model - we send a discover directly to this receiver
    if (typeof config.model === 'undefined' || config.model === '') {
        self.discover({address: config.host}, function (hosts) {
            if (hosts.length > 0) {
                self.connect(hosts[0]);
            }
            return;
        });
        return;
    }

    // Compute modelsets for this model (so commands which are possible on this model are allowed)
    set_modelsets();

    self.emit('debug', util.format(STRINGS.connecting, config.host, config.port));

    // Don't connect again if we have previously connected
    if (typeof eiscp === 'undefined') {

        eiscp = net.connect(connection_properties);

        eiscp.on('connect', function () {

            self.is_connected = true;
            self.emit('debug', util.format(STRINGS.connected, config.host, config.port));
            self.emit('connect');
        });

        eiscp.on('close', function () {

            self.is_connected = false;
            self.emit('debug', util.format(STRINGS.disconnected, config.host, config.port));
            self.emit('close', false);

            if (config.reconnect) {

                setTimeout(self.connect, config.reconnect_sleep * 1000);
            }
        });

        eiscp.on('error', function (err) {

            self.emit('error', util.format(STRINGS.server_error, config.host, config.port, err));
            eiscp.destroy();
        });

        eiscp.on('data', function (data) {

            var iscp_message = eiscp_packet_extract(data),
                result = iscp_to_command(iscp_message);

            result.iscp_command = iscp_message;

            self.emit('debug', util.format(STRINGS.received_data, config.host, config.port, result));

            self.emit('data', result);

            // If the command is supported we emit it as well
            if (typeof result.command !== 'undefined') {
                if (Array.isArray(result.command)) {
                    result.command.forEach(function (cmd) {
                        self.emit(cmd, result.argument);
                    });
                } else {
                    self.emit(result.command, result.argument);
                }
            }
        });

        return;
    }
    // Reconnect
    eiscp.connect(connection_properties);
    return;
};

self.close = self.disconnect = function () {

    if (self.is_connected) {
        eiscp.destroy();
    }
};

send_queue = async.queue(function (data, callback) {
    /*
      Syncronous queue which sends commands to device
    */
    if (self.is_connected) {
        self.emit('debug', util.format(STRINGS.sent_command, config.host, config.port, data));
        eiscp.write(eiscp_packet(data));
        if (typeof callback === 'function') {
            callback({ 'result': true, 'msg': '' });
        }
        return;
    }

    self.emit('error', util.format(STRINGS.send_not_connected, data));
    if (typeof callback === 'function') {
        callback({ 'result': false, 'msg': '' });
    }

}, 1);

self.raw = function (data, callback) {
    /*
      Send a low level command like PWR01
      callback only tells you that the command was sent but not that it succsessfully did what you asked
    */
    if (typeof data !== 'undefined' && data !== '') {

        send_queue.push(data, function (result) {

            if (typeof callback === 'function') {

                callback(result);
            }
        });

    } else if (typeof callback === 'function') {

        callback({ 'result': false, 'msg': 'No data provided.' });
    }
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
    var result = [];
    async.each(Object.keys(COMMAND_MAPPINGS[zone]), function (cmd, cb) {
        //console.log(cmd);
        result.push(cmd);
        cb();
    }, function (err) {
        callback(result);
    });
};

self.get_command = function (command, callback) {
    /*
      Returns all command values in given zone and command
    */
    var val, zone,
        result = [],
        parts = command.split('.');

    if (parts.length === 2) {
        zone = parts[0];
        command = parts[1];
    } else {
        zone = 'main';
        command = parts[0];
    }

    async.each(Object.keys(VALUE_MAPPINGS[zone][COMMAND_MAPPINGS[zone][command]]), function (val, cb) {
        result.push(val);
        cb();
    }, function (err) {
        callback(result);
    });
};
