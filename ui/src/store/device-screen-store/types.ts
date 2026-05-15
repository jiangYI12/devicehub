export type StartScreenStreamingMessage = {
  length: number
  orientation: number
  pid: number
  streamFormat?: 'image' | 'h264'
  videoCodec?: string
  quirks: {
    dumb: boolean
    alwaysUpright: boolean
    tear: boolean
  }
  alwaysUpright: boolean
  dumb: boolean
  tear: boolean
  realHeight: number
  realWidth: number
  version: number
  virtualHeight: number
  virtualWidth: number
}

export type ElementBoundSize = {
  width: number
  height: number
}
