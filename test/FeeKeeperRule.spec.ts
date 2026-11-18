import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import { needsEnableFees } from '../scripts/fee-keeper'

// The fee keepers' enableFees rule (bounty #111, Dex223-contracts#220). feeProtocol packs token0's
// denominator in the low four bits and token1's in the high four.
const pack = (p0: number, p1: number) => p0 + (p1 << 4)

describe('fee keeper enableFees rule', () => {
  describe('collector with the per-side rule', () => {
    it('leaves a pool with no listed token at 0 instead of resending it every run', () => {
      expect(needsEnableFees(true, 0, 4, 4, false, false, false)).to.eq(false)
    })
    it('turns on only the listed side of a fresh pool', () => {
      expect(needsEnableFees(true, 0, 4, 4, false, true, false)).to.eq(true)
      expect(needsEnableFees(true, pack(0, 4), 4, 4, false, true, false)).to.eq(false)
    })
    it('revisits a pool once its second token is listed', () => {
      expect(needsEnableFees(true, pack(0, 4), 4, 4, true, true, false)).to.eq(true)
      expect(needsEnableFees(true, pack(4, 4), 4, 4, true, true, false)).to.eq(false)
    })
    it('resets a side the old rule turned on for a token stakers cannot receive', () => {
      expect(needsEnableFees(true, pack(4, 4), 4, 4, false, true, false)).to.eq(true)
    })
    it('follows a changed default', () => {
      expect(needsEnableFees(true, pack(4, 4), 6, 6, true, true, false)).to.eq(true)
    })
    it('never touches a pool the owner configured by hand', () => {
      expect(needsEnableFees(true, pack(0, 0), 4, 4, true, true, true)).to.eq(false)
    })
  })

  describe('older collector (both defaults)', () => {
    it('only enables pools still at 0, as before', () => {
      expect(needsEnableFees(false, 0, 4, 4, false, false, false)).to.eq(true)
      expect(needsEnableFees(false, pack(4, 4), 4, 4, false, false, false)).to.eq(false)
      expect(needsEnableFees(false, 0, 0, 0, true, true, false)).to.eq(false)
      expect(needsEnableFees(false, 0, 4, 4, true, true, true)).to.eq(false)
    })
  })

  it('the Lambda keeper applies the same rule', () => {
    // ops/fee-keeper-lambda/index.mjs carries its own copy (it is bundled separately); compare every case.
    const src = fs.readFileSync(path.join(__dirname, '../ops/fee-keeper-lambda/index.mjs'), 'utf8')
    const m = src.match(/export function needsEnableFees\(([^)]*)\) \{([\s\S]*?)\n\}/)
    expect(m, 'needsEnableFees not found in the Lambda').to.not.eq(null)
    const lambda = new Function(...m![1].split(',').map((a) => a.trim()), m![2]) as typeof needsEnableFees
    const values = [0, 4, 6]
    let cases = 0
    for (const perSide of [true, false])
      for (const c0 of values) for (const c1 of values)
        for (const fp0 of values) for (const fp1 of values)
          for (const l0 of [true, false]) for (const l1 of [true, false]) for (const custom of [true, false]) {
            const args = [perSide, pack(c0, c1), fp0, fp1, l0, l1, custom] as const
            expect(lambda(...args), JSON.stringify(args)).to.eq(needsEnableFees(...args))
            cases++
          }
    expect(cases).to.eq(2 * 81 * 8)
  })
})
