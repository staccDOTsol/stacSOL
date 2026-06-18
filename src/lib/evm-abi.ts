// Minimal ABIs for stacSOL EVM vaults (ERC-4626 + ERC-20).

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
] as const

export const erc4626Abi = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'asset',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'previewDeposit',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'previewRedeem',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/** Lido stETH — payable submit mints stETH from native ETH. */
export const lidoStEthAbi = [
  {
    type: 'function',
    name: 'submit',
    inputs: [{ name: 'referral', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'payable',
  },
] as const

export const wstEthAbi = [
  {
    type: 'function',
    name: 'wrap',
    inputs: [{ name: 'stETHAmount', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'unwrap',
    inputs: [{ name: 'wstETHAmount', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  ...erc20Abi,
] as const

export const LIDO_STETH = '0xae7ab96520de3a18e1167f7a11e7ff2415c558497' as const
export const WSTETH_MAINNET = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0' as const

/** Kinetiq liquid staking on HyperEVM — stake() mints kHYPE. */
export const KINETIQ_STAKING =
  '0x393d0b87ed38fc779fd9611144ae649ba6082109' as const
export const KHYPE = '0xfd739d4e423301ce9385c1fb8850539d657c296d' as const

export const kinetiqStakeAbi = [
  {
    type: 'function',
    name: 'stake',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
  },
] as const

/** Kinetiq requires stake amounts divisible by 1e10 wei. */
export const KINETIQ_STAKE_STEP = 10_000_000_000n