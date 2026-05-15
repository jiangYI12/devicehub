type OnFrame = (frame: VideoFrame) => void
type OnError = (error: Error) => void
type AnnexBVideoDecoderConfig = VideoDecoderConfig & {
  avc?: {
    format: 'annexb'
  }
}
type H264BitstreamFormat = 'annexb' | 'avcc'

const H264_NAL_SPS = 7
const H264_NAL_PPS = 8
const H264_NAL_AUD = 9

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

function findStartCode(data: Uint8Array, fromIndex: number): { index: number; prefixLength: number } | null {
  for (let index = fromIndex; index <= data.length - 4; index += 1) {
    if (data[index] === 0x00 && data[index + 1] === 0x00) {
      if (data[index + 2] === 0x01) {
        return { index, prefixLength: 3 }
      }

      if (data[index + 2] === 0x00 && data[index + 3] === 0x01) {
        return { index, prefixLength: 4 }
      }
    }
  }

  return null
}

function discardEmulationPreventionBytes(data: Uint8Array): Uint8Array {
  const output: number[] = []

  for (let index = 0; index < data.length; index += 1) {
    if (
      index >= 2 &&
      data[index] === 0x03 &&
      data[index - 1] === 0x00 &&
      data[index - 2] === 0x00
    ) {
      continue
    }

    output.push(data[index])
  }

  return Uint8Array.from(output)
}

class BitReader {
  private bitOffset = 0

  constructor(private readonly data: Uint8Array) {}

  readBit(): number {
    if (this.bitOffset >= this.data.length * 8) {
      return 0
    }

    const byteOffset = this.bitOffset >> 3
    const shift = 7 - (this.bitOffset & 7)
    const bit = (this.data[byteOffset] >> shift) & 0x01
    this.bitOffset += 1

    return bit
  }

  readUnsignedExpGolomb(): number {
    let leadingZeroBits = 0

    while (this.readBit() === 0 && leadingZeroBits < 32) {
      leadingZeroBits += 1
    }

    let value = 1

    for (let index = 0; index < leadingZeroBits; index += 1) {
      value = (value << 1) | this.readBit()
    }

    return value - 1
  }
}

function isFirstSliceOfPicture(data: Uint8Array): boolean {
  const rbsp = discardEmulationPreventionBytes(data)
  const bitReader = new BitReader(rbsp)

  return bitReader.readUnsignedExpGolomb() === 0
}

function codecFromSps(data: Uint8Array): string | null {
  if (data.length < 4) {
    return null
  }

  const rbsp = discardEmulationPreventionBytes(data)

  if (rbsp.length < 3) {
    return null
  }

  const profileIdc = rbsp[0]
  const constraints = rbsp[1]
  const levelIdc = rbsp[2]

  return `avc1.${[profileIdc, constraints, levelIdc].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export class ScrcpyH264Decoder {
  private decoder: VideoDecoder | null = null
  private codec: string | null = null
  private configured = false
  private inputBuffer = new Uint8Array(0)
  private bitstreamFormat: H264BitstreamFormat | null = null
  private accessUnit: Uint8Array[] = []
  private accessUnitHasVcl = false
  private accessUnitIsKeyFrame = false
  private timestamp = 0
  private receivedKeyFrame = false

  constructor(
    private readonly onFrame: OnFrame,
    private readonly onError: OnError
  ) {}

  get isSupported(): boolean {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
  }

  async pushChunk(chunk: Blob | ArrayBuffer): Promise<void> {
    if (!this.isSupported) {
      this.onError(new Error('WebCodecs is not supported in this browser'))
      return
    }

    const data = chunk instanceof Blob ? new Uint8Array(await chunk.arrayBuffer()) : new Uint8Array(chunk)

    if (!data.length) {
      return
    }

    this.inputBuffer = new Uint8Array(concatUint8Arrays([this.inputBuffer, data]))
    this.consumeInputBuffer()
  }

  reset(): void {
    this.inputBuffer = new Uint8Array(0)
    this.bitstreamFormat = null
    this.accessUnit = []
    this.accessUnitHasVcl = false
    this.accessUnitIsKeyFrame = false
    this.timestamp = 0
    this.receivedKeyFrame = false

    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close()
    }

    this.decoder = null
    this.configured = false
  }

  flush(): void {
    this.flushAccessUnit()
  }

  private consumeInputBuffer(): void {
    if (!this.bitstreamFormat) {
      const startCode = findStartCode(this.inputBuffer, 0)

      if (startCode?.index === 0) {
        this.bitstreamFormat = 'annexb'
      } else if (this.inputBuffer.length >= 4) {
        this.bitstreamFormat = 'avcc'
      } else {
        return
      }
    }

    if (this.bitstreamFormat === 'annexb') {
      this.consumeAnnexBInputBuffer()
      return
    }

    this.consumeAvccInputBuffer()
  }

  private consumeAnnexBInputBuffer(): void {
    const startCode = findStartCode(this.inputBuffer, 0)

    if (!startCode) {
      return
    }

    let cursor = startCode.index
    let currentStartCode = startCode

    while (true) {
      const nextStartCode = findStartCode(this.inputBuffer, cursor + currentStartCode.prefixLength)

      if (!nextStartCode) {
        break
      }

      const nalUnit = this.inputBuffer.subarray(cursor, nextStartCode.index)
      this.consumeNalUnit(nalUnit, currentStartCode.prefixLength)
      cursor = nextStartCode.index
      currentStartCode = nextStartCode
    }

    this.inputBuffer = this.inputBuffer.subarray(cursor)
  }

  private consumeAvccInputBuffer(): void {
    let cursor = 0

    while (this.inputBuffer.length - cursor >= 4) {
      const view = new DataView(
        this.inputBuffer.buffer,
        this.inputBuffer.byteOffset + cursor,
        this.inputBuffer.byteLength - cursor
      )
      const nalLength = view.getUint32(0, false)

      if (nalLength <= 0) {
        this.onError(new Error('Scrcpy decoder received an invalid AVCC NAL unit length'))
        this.reset()
        return
      }

      if (this.inputBuffer.length - cursor < 4 + nalLength) {
        break
      }

      const avccNalUnit = this.inputBuffer.subarray(cursor + 4, cursor + 4 + nalLength)
      const annexBNalUnit = new Uint8Array(4 + avccNalUnit.length)
      annexBNalUnit.set([0x00, 0x00, 0x00, 0x01], 0)
      annexBNalUnit.set(avccNalUnit, 4)
      this.consumeNalUnit(annexBNalUnit, 4)
      cursor += 4 + nalLength
    }

    this.inputBuffer = this.inputBuffer.subarray(cursor)
  }

  private consumeNalUnit(nalUnit: Uint8Array, prefixLength: number): void {
    if (nalUnit.length <= prefixLength) {
      return
    }

    const nalHeaderIndex = prefixLength
    const nalType = nalUnit[nalHeaderIndex] & 0x1f
    const nalPayload = nalUnit.subarray(nalHeaderIndex + 1)
    const isVcl = nalType >= 1 && nalType <= 5
    const startsNewPicture = isVcl && this.accessUnitHasVcl && isFirstSliceOfPicture(nalPayload)
    const shouldFlush =
      this.accessUnit.length > 0 &&
      (nalType === H264_NAL_AUD || startsNewPicture || ((nalType === H264_NAL_SPS || nalType === H264_NAL_PPS) && this.accessUnitHasVcl))

    if (shouldFlush) {
      this.flushAccessUnit()
    }

    if (nalType === H264_NAL_SPS && !this.codec) {
      this.codec = codecFromSps(nalPayload)
    }

    this.accessUnit.push(new Uint8Array(nalUnit))

    if (isVcl) {
      this.accessUnitHasVcl = true
      if (nalType === 5) {
        this.accessUnitIsKeyFrame = true
      }
    }
  }

  private flushAccessUnit(): void {
    if (!this.accessUnit.length || !this.accessUnitHasVcl) {
      this.accessUnit = []
      this.accessUnitHasVcl = false
      this.accessUnitIsKeyFrame = false
      return
    }

    if (!this.decoder) {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (error) => this.onError(error instanceof Error ? error : new Error(String(error))),
      })
    }

    if (!this.configured) {
      if (!this.codec) {
        return
      }

      this.decoder.configure({
        codec: this.codec,
        optimizeForLatency: true,
        avc: {
          format: 'annexb',
        },
      } as AnnexBVideoDecoderConfig)
      this.configured = true
    }

    if (!this.receivedKeyFrame && !this.accessUnitIsKeyFrame) {
      this.accessUnit = []
      this.accessUnitHasVcl = false
      this.accessUnitIsKeyFrame = false
      return
    }

    this.receivedKeyFrame = true

    const data = concatUint8Arrays(this.accessUnit)
    const chunk = new EncodedVideoChunk({
      type: this.accessUnitIsKeyFrame ? 'key' : 'delta',
      timestamp: this.timestamp,
      data,
    })

    this.timestamp += 33_333
    this.decoder.decode(chunk)

    this.accessUnit = []
    this.accessUnitHasVcl = false
    this.accessUnitIsKeyFrame = false
  }
}
