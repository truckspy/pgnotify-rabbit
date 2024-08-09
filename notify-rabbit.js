#!/usr/bin/env node

/*
 * Small application that connects to one or more databases and listens for
 * notifications, passing them on to a rabbitmq instance allowing code inside
 * the database to do realtime messaging out to the rest of the system.
 */

console.log("notify-rabbit V0.1");

const options = {};
process.argv.forEach((val, index) => {

    const opt = val.split('=');
    if (opt.length===2) {
        Object.assign(options, {[opt[0]]: opt[1]})
    }
});

console.log(options);

var config = require('./config')({
        ...options,
        databases: true
    }),
        amqp = require('amqplib');

config.notify({
    // Log entire message to the console
    console: function (c, n, v) {
        if (v === true) {
            return function (m) {
                console.log(['Notify', n.database, n.name, JSON.stringify(m)].join(':'));
            };
        }
        return null;
    },
    // Publish the message to a rabbit topic
    rabbit: function (c, n, v) {
        var o = {
            // Connection details
            uri: c.rabbit[v.instance],
            channel: false,
            // Topic or default to amq.topic
            topic: v.topic ? v.topic : 'amq.topic',
            // Routing key, send as is if defined
            key: v.key,
            // If an object then the key holding the route and payload.
            // For payload undefined here means the parent object rather than]
            // a child/ Only valid if json is true
            routingKey: v.routingKey,
            payload: v.payload,
            typeHeader: v.typeHeader,
            // Message parsed into json?
            json: n.json,
            // Function to handle publishing
            publish: function (m) {
                if (this.channel) {

                    // Plain send to route
                    if (this.key)
                        this.channel.publish(
                                this.topic,
                                this.key,
                                Buffer.from(this.json ? JSON.stringify(m) : m)
                                );

                    if (this.routingKey && this.json) {

                        this.channel.publish(
                                this.topic,
                                m[this.routingKey],
                                Buffer.from(JSON.stringify(
                                this.payload ? m[this.payload] : m
                                )),
                                {
                                    persistent: true,
                                    noAck: false,
                                    timestamp: Date.now(),
                                    contentEncoding: "utf-8",
                                    contentType: "application/json",
                                    headers: {
                                        xtype: m[this.typeHeader]
                                    }
                                }
                                );
                    }
                }
            }
        };

        // No uri or if not json then no key then don't do anything
        if (!o.uri || (!o.key && !o.json))
            return null;

        var conn = amqp.connect(o.uri, {
            clientProperties: {
                // Show what this connection is for in management
                connection_name: 'Notify ' + n.database + ' ' + n.name
            }
        })
                .then(function (conn) {
                    o.conn = conn;
                    return conn.createChannel();
                })
                .then(function (channel) {
                    channel.on('close', function () {
                        console.log('Channel closed ' + n.database + ' ' + n.name);
                        // Exit the application, docker will restart if configured that way
                        process.exit(1);
                    });
                    return channel;
                })
                .then(function (channel) {
                    channel.prefetch(1);
                    o.channel = channel;
                    return channel;
                })
                .catch(function (e) {
                    console.error(e);
                    process.exit(1);
                });

        return function (m) {
            try {
                o.publish(m);
            } catch (e) {
                console.error(e);
            }
        };
    }
});
