import Promise from 'bluebird'
import EventEmitter from 'events'
import {fileURLToPath} from 'url'
import path from 'path'
import net from 'net'
import {PromiseSocket} from 'promise-socket'
import syrup from '@devicefarmer/stf-syrup'
import logger from '../../../util/logger.js'
import adb from '../support/adb.js'
import properties from '../support/properties.js'
import abi from '../support/abi.js'
import sdk from '../support/sdk.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default syrup.serial()
    .dependency(adb)
    .dependency(properties)
    .dependency(abi)
    .dependency(sdk)
    .define(function(options, adb, properties, abi, sdk) {
        let log = logger.createLogger('device:resources:scrcpy')
        class Scrcpy extends EventEmitter {
            constructor(config) {
                super()
                this._config = Object.assign({
                    deviceId: options.serial,
                    port: 8099,
                    maxSize: 600,
                    bitrate: 999999999,
                    tunnelForward: true,
                    tunnelDelay: 3000,
                    crop: '9999:9999:0:0',
                    sendFrameMeta: false
                }, config)
                this.adbClient = adb
            }

            /**
         * Will connect to the android device, send & run the server and return deviceName, width and height.
         * After that data will be offered as a 'data' event.
         */
            async start() {
                log.info('Starting scrcpy server for device %s', options.serial)
            // Transfer server...
                await this.adbClient.getDevice(options.serial).push(path.join(__dirname, 'scrcpy-server.jar'), '/data/local/tmp/scrcpy-server.jar')
                    .then(transfer => new Promise(((resolve, reject) => {
                        transfer.on('progress', (stats) => {
                            log.info('[%s] Pushed %d bytes so far', options.serial, stats.bytesTransferred)
                        })
                        transfer.on('end', () => {
                            log.info('[%s] Push complete', options.serial)
                            resolve()
                        })
                        transfer.on('error', reject)
                    })))
                    .catch(e => {
                        log.error('Impossible to transfer server file: %s', e?.stack || e?.message || e)
                        throw e
                    })
                // Run server
                await this.adbClient.getDevice(options.serial).shell('CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / ' +
                `com.genymobile.scrcpy.Server ${this._config.maxSize} ${this._config.bitrate} ${this._config.tunnelForward} ` +
                `${this._config.crop} false`)
                    .catch(e => {
                        log.error('Impossible to run server: %s', e?.stack || e?.message || e)
                        throw e
                    })
                log.info('Started scrcpy server')
                await this.adbClient.getDevice(options.serial).forward(`tcp:${this._config.port}`, 'localabstract:scrcpy')
                    .catch(e => {
                        log.error('Impossible to forward port %d: %s', this._config.port, e?.stack || e?.message || e)
                        throw e
                    })
                log.info('Forwarded scrcpy port %d', this._config.port)
                this.socket = new PromiseSocket(new net.Socket())
                // Wait 1 sec to forward to work
                await Promise.delay(this._config.tunnelDelay)
                // Connect
                await this.socket.connect(this._config.port, '127.0.0.1')
                    .catch(e => {
                        log.error('Impossible to connect "127.0.0.1:%d": %s', this._config.port, e?.stack || e?.message || e)
                        throw e
                    })
                log.info('Connected to local scrcpy socket')
                // First chunk is 69 bytes length -> 1 dummy byte, 64 bytes for deviceName, 2 bytes for width & 2 bytes for height
                const firstChunk = await this.socket.read(69)
                    .catch(e => {
                        log.error('Impossible to read first scrcpy chunk: %s', e?.stack || e?.message || e)
                        throw e
                    })
                log.info('Received first scrcpy chunk')
                const name = firstChunk.slice(1, 65).toString('utf8')
                const width = firstChunk.readUInt16BE(65)
                const height = firstChunk.readUInt16BE(67)
                log.info('Scrcpy stream dimensions for %s: %dx%d', name, width, height)
                return {name, width, height}
            }
            startStreamRaw() {
                this._startStreamRaw()
            }
            stop() {
                if (this.socket) {
                    this._stopStreamRaw()
                    this.socket.destroy()
                    this.socket = null
                }
            }
            _startStreamRaw() {
                if (!this.socket || this.rawDataListener) {
                    return
                }

                this.rawDataListener = d => {
                    this.emit('rawData', d)
                }
                this.socket.stream.on('data', this.rawDataListener)
                this.socket.stream.on('close', this._handleSocketClosed)
                this.socket.stream.on('error', this._handleSocketError)
            }
            _stopStreamRaw() {
                if (!this.socket || !this.rawDataListener) {
                    return
                }

                this.socket.stream.off('data', this.rawDataListener)
                this.socket.stream.off('close', this._handleSocketClosed)
                this.socket.stream.off('error', this._handleSocketError)
                this.rawDataListener = null
            }
            rawDataListener = null
            _handleSocketClosed = () => {
                this.emit('close')
            }
            _handleSocketError = (error) => {
                this.emit('error', error)
            }
        }
        return {
            Scrcpy
        }
    })
