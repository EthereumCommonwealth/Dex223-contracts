// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.6.0;

import '../../interfaces/IUniswapV3Pool.sol';

/// @title PoolTicksCounter
/// @notice Counts the number of initialized ticks crossed during a swap
/// @dev Security-hardened version addressing underflow, negative-modulo,
///      truncation, and gas-efficiency issues present in the original.
library PoolTicksCounter {
    /// @dev This function counts the number of initialized ticks that would incur a gas cost between tickBefore
    ///      and tickAfter. When tickBefore and/or tickAfter themselves are initialized, the logic over whether
    ///      we should count them depends on the direction of the swap. If we are swapping upwards
    ///      (tickAfter > tickBefore) we don't want to count tickBefore but we do want to count tickAfter.
    ///      The opposite is true if we are swapping downwards.
    function countInitializedTicksCrossed(
        IUniswapV3Pool self,
        int24 tickBefore,
        int24 tickAfter
    ) internal view returns (uint32 initializedTicksCrossed) {
        int16 wordPosLower;
        int16 wordPosHigher;
        uint8 bitPosLower;
        uint8 bitPosHigher;
        bool tickBeforeInitialized;
        bool tickAfterInitialized;

        {
            // [FIX V-06] Cache tickSpacing to avoid redundant external STATICCALL calls
            int24 spacing = self.tickSpacing();

            // [FIX V-02] Use a helper that floors the division for negative values,
            // then compute wordPos and bitPos safely. In Solidity <0.8, signed modulo
            // preserves the sign of the dividend (e.g., (-5) % 256 == -5), which produces
            // incorrect bitPos when cast to uint8. We use _compress() to get a
            // floor-divided compressed tick and _position() to safely split it.
            int24 compressedBefore = _compress(tickBefore, spacing);
            int24 compressedAfter = _compress(tickAfter, spacing);

            // [FIX V-03] Safe wordPos/bitPos computation that avoids int16 truncation
            (int16 wordPos, uint8 bitPos) = _position(compressedBefore);
            (int16 wordPosAfter, uint8 bitPosAfter) = _position(compressedAfter);

            // In the case where tickAfter is initialized, we only want to count it if we are
            // swapping downwards. If the initializable tick after the swap is initialized, our
            // original tickAfter is a multiple of tick spacing, and we are swapping downwards we
            // know that tickAfter is initialized and we shouldn't count it.
            tickAfterInitialized =
                ((self.tickBitmap(wordPosAfter) & (1 << bitPosAfter)) > 0) &&
                ((tickAfter % spacing) == 0) &&
                (tickBefore > tickAfter);

            // In the case where tickBefore is initialized, we only want to count it if we are
            // swapping upwards. Use the same logic as above to decide whether we should count
            // tickBefore or not.
            tickBeforeInitialized =
                ((self.tickBitmap(wordPos) & (1 << bitPos)) > 0) &&
                ((tickBefore % spacing) == 0) &&
                (tickBefore < tickAfter);

            if (wordPos < wordPosAfter || (wordPos == wordPosAfter && bitPos <= bitPosAfter)) {
                wordPosLower = wordPos;
                bitPosLower = bitPos;
                wordPosHigher = wordPosAfter;
                bitPosHigher = bitPosAfter;
            } else {
                wordPosLower = wordPosAfter;
                bitPosLower = bitPosAfter;
                wordPosHigher = wordPos;
                bitPosHigher = bitPos;
            }
        }

        // Count the number of initialized ticks crossed by iterating through the tick bitmap.
        // Our first mask should include the lower tick and everything to its left.
        uint256 mask = type(uint256).max << bitPosLower;
        while (wordPosLower <= wordPosHigher) {
            // If we're on the final tick bitmap page, ensure we only count up to our ending tick.
            if (wordPosLower == wordPosHigher) {
                mask = mask & (type(uint256).max >> (255 - bitPosHigher));
            }

            uint256 masked = self.tickBitmap(wordPosLower) & mask;
            initializedTicksCrossed += countOneBits(masked);

            // [FIX V-04] Prevent int16 overflow on increment: break before incrementing past
            // wordPosHigher or reaching int16 max, which would wrap to -32768 causing an
            // infinite loop in Solidity <0.8 (no overflow checks).
            if (wordPosLower == wordPosHigher) break;
            wordPosLower++;

            // Reset our mask so we consider all bits on the next iteration.
            mask = type(uint256).max;
        }

        // [FIX V-01] Guard against uint32 underflow. In Solidity <0.8, unsigned subtraction
        // silently wraps: 0 - 1 == type(uint32).max. This can happen if the bitmap iteration
        // counted no initialized ticks but the boundary tick checks set the initialized flags.
        if (tickAfterInitialized && initializedTicksCrossed > 0) {
            initializedTicksCrossed -= 1;
        }

        if (tickBeforeInitialized && initializedTicksCrossed > 0) {
            initializedTicksCrossed -= 1;
        }

        return initializedTicksCrossed;
    }

    /// @dev Compresses a tick by the spacing using floor division.
    ///      Standard Solidity signed division truncates towards zero, but for bitmap
    ///      addressing we need floor division (towards negative infinity).
    ///      Example: tick = -5, spacing = 10 => Solidity gives 0, but floor gives -1.
    function _compress(int24 tick, int24 spacing) private pure returns (int24) {
        int24 compressed = tick / spacing;
        // Round towards negative infinity if tick is negative and not evenly divisible
        if (tick < 0 && tick % spacing != 0) {
            compressed--;
        }
        return compressed;
    }

    /// @dev Safely splits a compressed tick into its bitmap word position and bit position.
    ///      Uses floor-division-aware arithmetic so that negative compressed ticks produce
    ///      correct (non-negative) bitPos values.
    function _position(int24 compressed) private pure returns (int16 wordPos, uint8 bitPos) {
        // Arithmetic right-shift by 8 is equivalent to floor division by 256 for signed ints
        wordPos = int16(compressed >> 8);
        // For bitPos: compressed & 0xFF always yields 0..255 regardless of sign,
        // because bitwise-AND on two's complement extracts the low 8 bits correctly.
        bitPos = uint8(uint24(compressed) & 0xFF);
    }

    /// @dev Counts set bits using the Kernighan algorithm.
    function countOneBits(uint256 x) private pure returns (uint16) {
        uint16 bits = 0;
        while (x != 0) {
            bits++;
            x &= (x - 1);
        }
        return bits;
    }
}
