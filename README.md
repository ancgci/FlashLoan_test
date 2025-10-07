# Flash Loan Arbitrage Bot

Flash loan arbitrage project between Camelot and Sushiswap on Arbitrum.

## How it works

The concept is simple:
1. Borrow USDC via flash loan on Aave
2. Swap USDC → WETH on Camelot
3. Swap WETH → USDC on Sushiswap
4. Repay the flash loan
5. Keep the profit (if any)

The `ArbitrageFlashLoan.sol` contract handles everything automatically. Once it receives tokens from Aave, it executes the swaps and repays immediately.

## Project structure

```
contracts/
  ├── src/
  │   └── ArbitrageFlashLoan.sol    # Main contract
  └── script/
      └── DeployFlashLoan.s.sol     # Deployment script

bot/
  └── src/
      ├── arbitrage-bot.js          # Monitoring bot
      └── monitoring.js             # Opportunity tracking
```

## Deployment

Using Foundry to deploy on Arbitrum:

```bash
cd contracts
forge script script/DeployFlashLoan.s.sol:DeployFlashLoan --rpc-url $ARBITRUM_RPC --broadcast --verify
```

The script automatically configures:
- Aave pool address
- Sushiswap and Camelot routers
- Tokens for arbitrage (USDC/WETH)

## Monitoring

The bot continuously monitors prices on both DEXs to detect opportunities:

```bash
cd bot/src
node arbitrage-bot.js
```

When it finds an interesting price difference, it calculates if it's profitable after fees (swap + flash loan) and triggers the flash loan automatically.

## Configuration

Create a `.env` file in `bot/src/`:

```
PRIVATE_KEY=your_key
ARBITRUM_RPC=your_rpc
CONTRACT_ADDRESS=deployed_contract_address
```

## Foundry

This project uses Foundry for development:

**Build**
```shell
forge build
```

**Test**
```shell
forge test
```

**Deploy**
```shell
forge script script/DeployFlashLoan.s.sol --rpc-url <rpc> --broadcast
```

Full documentation: https://book.getfoundry.sh/
