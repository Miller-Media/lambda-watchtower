const https = require("https")
const http = require("http")
const net = require("net")
const {hrtime} = process
const AWS = require("aws-sdk")
const cloudwatch = new AWS.CloudWatch()

const hrToMs = (timing) => Math.round(timing[0] * 1000 + timing[1] / 1000000)
const hrDiff = (start, end) => hrToMs(end) - hrToMs(start)
const timingsDiff = (timings, key1, key2) =>
    (timings[key1] && timings[key2] && hrDiff(timings[key1], timings[key2])) || -1
const defaultTimeout = 5000

const processTimings = function(timings) {
    return {
        lookup: timingsDiff(timings, "start", "lookup"),
        connect: timingsDiff(timings, "lookup", "connect"), 
        secureConnect: timingsDiff(timings, "connect", "secureConnect"),
        readable: timingsDiff(timings, "secureConnect", "readable") || timingsDiff(timings, "connect", "readable"),
        close: timingsDiff(timings, "readable", "close"),
        total: timingsDiff(timings, "start", "close")
    }
}

const createRequest = function(url, callback) {
    const handler = url.startsWith("http://") ? http : https
    return handler.get(url, callback)
}

const sendData = (data, event) => Promise.all(
    data
        .reduce((acc, metric) => {
            let arr = acc[acc.length - 1]
            if (!arr || arr.length >= 10) {
                acc.push([metric])
            } else {
                arr.push(metric)
            }
            return acc
        }, [])
        .map(metricData => cloudwatch.putMetricData({
            Namespace: event.namespace || "Watchtower",
            MetricData: metricData
        }).promise())
)

const sendApiRequest = function(endpoint, data, method, event) {
    return new Promise(function(resolve, reject) {
        const options = {
            hostname: event.api_host,
            path: `/api/v0/${endpoint}`,
            method: method,
            headers: {
                'x-api-key': event.api_key
            }
        }

        if (data) {
            options.headers['Content-Type'] = 'application/json'
            options.headers['Content-Length'] = Buffer.byteLength(data)
        }

        const req = https.request(options, (res) => {
            var data = ''
            res.on('readable', function() {
                let chunk;
                while (chunk = this.read()) {
                    data += chunk
                }
            })
            res.on('end', (d) => resolve(JSON.parse(data)))
            res.on('error', (e) => reject(Error(e)))
        })

        if (data) {
            req.write(data)
        }

        req.end()
    })
}

/**
 * Update Component Status
 * 
 * @result  {Object} handler.http request result
 * @event   {Object} Lambda event data
 */
const updateComponent = function(result, event) {
    const status = result.statusCode === 200 ? "Operational" : "Major Outage"
    const endpoint = `components/${result.component}`
    const data = {status: status}
    return sendApiRequest(endpoint, JSON.stringify(data), 'PATCH', event)
}

const getOpenIncidents = function(event) {
    return new Promise(function(resolve, reject) {
        sendApiRequest('incidents', null, 'GET', event).then(data => {
            resolve(data.filter(i => i.status !== 'Resolved'))
        }).catch(error => {
            reject(error)
        })
    })
}

/**
 * Create new Incident
 * 
 * @result  {Object} handler.http request result
 * @incidents {Object[]} Existing open incidents
 * @event   {Object} Lambda event data
 */
const createIncident = function(result, incidents, event) {
    const incidentName = `${result.name} - Site Outage`
    const existing = incidents.filter(i => i.name === incidentName)

    if (existing.length === 0) {
        const data = { 
            name: incidentName,
            status: "Identified",
            message: `${result.name} is currently unavailable (HTTP ${result.statusCode}).`
        }

        sendApiRequest('incidents', JSON.stringify(data), 'POST', event).then(incident => {
            console.log(`Created Incident ${incident.incidentID}: ${incident.name}`)
        }).catch(error => {
            console.log(error)
        })
    }

}

/**
 * Resolve existing Incident
 * 
 * @result  {Object} handler.http request result
 * @incidents {Object[]} Existing open incidents
 * @event   {Object} Lambda event data
 */
const resolveIncident = function(result, incidents, event) {
    const incidentName = `${result.name} - Site Outage`
    const existing = incidents.filter(i => i.name === incidentName)

    if (existing.length === 1) {
        const endpoint = `incidents/${existing[0].incidentID}`
        const data = {
            status: "Resolved",
            message: `${result.name} is currently operating normally.`
        }

        sendApiRequest(endpoint, JSON.stringify(data), 'PATCH', event).then(incident => {
            console.log(`Resolved Incident ${incident.incidentID}: ${incident.name}`)
        }).catch(error => {
            console.log(error)
        })
    }
}

const handlers = {}

/**
 * Query HTTP(S) Endpoints and log timings and HTTP status with CloudWatch
 * 
 * @param {Object} event - Requested checks
 * @param {Object[]} event.targets - Endpoints to be checked
 * @param {string} [event.targets[].url] - Endpoint URL - use for http(s) endpoints
 * @param {string} [event.targets[].hostname] - Endpoint Hostname - use for non-http(s) endpoints
 * @param {string} [event.targets[].name] - Endpoint Name
 * @param {string} [event.targets[].type] - Check type - can be "http(s)" or "port". Defaults to "http(s)"
 * @param {string[]} [event.logTimings=["readable", "total"]] - Determine which timings are logged.
 * @param {string} [event.namespace="Watchtower"] - CloudWatch namespace
 * @param {number} [event.timeout=2000] - Time in ms before requests are aborted.
 * @param {function} callback - Lambda callback function
 * 
 * @returns {Promise} - Promise that resolves if all checks were successful and data was stored in CloudWatch
 */
exports.handler = function(event, context, callback) {
    const targets = event.targets
    if (!targets) callback("No targets given")

    const requests = targets.map(target => new Promise((resolve, reject) => {
        const data = {
            name: target.name || target.url,
            timings: {
                start: hrtime()
            },
            component: target.component
        }
        switch (target.type) {
        case "smtp":
            handlers.smtp(target, data, event, resolve, reject)
            break
        case "port":
            handlers.port(target, data, event, resolve, reject)
            break
        default:
            handlers.http(target, data, event, resolve, reject)
        }
    }))
    
    return Promise.all(requests).then(results => {
        const timestamp = new Date()
        const includedTimings = event.logTimings || ["readable", "total"]
        const metricData = results.map(result => {
            const timingMetrics = includedTimings.map(timing => {
                return {
                    MetricName: `timing-${timing}`,
                    Dimensions: [{Name: result.name, Value: `Timing: ${timing}`}],
                    Value: result.durations[timing],
                    Unit: "Milliseconds",
                    Timestamp: timestamp
                }
            })
            return [{
                MetricName: "status",
                Dimensions: [{Name: result.name, Value: "HTTP Status"}],
                Value: result.statusCode,
                Timestamp: timestamp
            }, ...timingMetrics]
        }).reduce((acc, val) => [...acc, ...val], [])

        /*
         * For any results which do not have an HTTP 200 response code, update the
         * component status to 'Major Outage' and create a new incident. Close any
         * open incidents for results with a 200 response code.
         */
        getOpenIncidents(event).then(incidents => {
            for (const result of results) {
                updateComponent(result, event).then(data => {
                    if (result.statusCode !== 200) {
                        createIncident(result, incidents, event)
                    } else {
                        resolveIncident(result, incidents, event)
                    }
                }).catch(error => {
                    console.log(error)
                })
            }
        }).catch(error => {
            console.log(error)
        })

        return sendData(metricData, event)
            .then(data => {
                callback(null, data)
            })
            .catch(error => {
                callback(error, null)
            })

    }).catch(error => {
        callback(error)
    })
}

/*
Check handler for HTTP(S)
*/
handlers.http = (target, data, event, resolve, reject) => {
    const request = createRequest(target.url, response => {
        data.statusCode = response.statusCode
        response.once("readable", () => data.timings.readable = hrtime())
        response.once("end", () => data.timings.end = hrtime())
    })
    request.setTimeout(1)
    const timeout = setTimeout(() => request.abort(), event.timeout || defaultTimeout)
    request.on("socket", socket => {
        socket.on("lookup", () => data.timings.lookup = hrtime())
        socket.on("connect", () => data.timings.connect = hrtime())
        socket.on("secureConnect", () => data.timings.secureConnect = hrtime())
    })
    request.on("close", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        clearTimeout(timeout)
        resolve(data)
    })
    request.on("error", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = typeof data.statusCode !== "undefined" ? data.statusCode : 0
        clearTimeout(timeout)
        resolve(data)
    })
}

/*
Check handler for ports
*/
handlers.port = (target, data, event, resolve, reject) => {
    const socket = new net.Socket()
    socket.setTimeout(event.timeout || defaultTimeout)

    socket.on("connect",() => {
        data.timings.connect = hrtime()
    })
    socket.on("lookup",() => {
        data.timings.lookup = hrtime()
    })
    socket.on("data",() => {
        data.timings.readable = hrtime()
        socket.end()
    })
    socket.on("end",() => {
        data.timings.end = hrtime()
    })
    socket.on("error",() => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = -1
        socket.destroy()
        resolve(data)
    })
    socket.on("timeout", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = -1
        socket.destroy()
        resolve(data)
    })
    socket.on("close", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = 0
        socket.destroy()
        resolve(data)
    })

    socket.connect(target.port, target.hostname, () => {})
}

handlers.smtp = (target, data, event, resolve, reject) => {

    const socket = new net.Socket()
    const smtpFlags = {}
    socket.setTimeout(event.timeout || defaultTimeout)
    socket.setEncoding("utf8")

    socket.on("connect",() => {
        data.timings.connect = hrtime()
    })
    socket.on("lookup",() => {
        data.timings.lookup = hrtime()
    })
    socket.on("data",(smtpdata) => {
        if(smtpdata.match(/^220/) && smtpFlags.greeting !== true) {
            socket.write("EHLO lambda-watchtower.test\r\n","utf8")
            smtpFlags.greeting = true
        } else if(smtpdata.match(/^250/)) {
            data.timings.readable = hrtime()
            socket.end()
        }
    })
    socket.on("end",() => {
        data.timings.end = hrtime()
    })
    socket.on("error",() => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = -1
        socket.destroy()
        resolve(data)
    })
    socket.on("timeout", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = -1
        socket.destroy()
        resolve(data)
    })
    socket.on("close", () => {
        data.timings.close = hrtime()
        data.durations = processTimings(data.timings)
        data.statusCode = 0
        socket.destroy()
        resolve(data)
    })

    socket.connect(target.port, target.hostname, () => {})

}
