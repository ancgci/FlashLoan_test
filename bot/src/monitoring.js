// monitor.js
require('dotenv').config();
const { ethers } = require('ethers');

class ArbitrageMonitor {
    constructor() {
        // RPC Arbitrum
        this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

        // Configuration DEX
        this.DEX = {
            camelot: {
                router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", // AMMv3
                factory: "0x6EcCab422D763aC031210895C81787E87B43A652" // AMMv3
            },
            sushi: {
                router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
                factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
            }

        };

        // Paires à surveiller
        this.pairs = {
            'USDC/WETH': {
                addresses: {
                    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
                    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
                },
                decimals: {
                    USDC: 6,
                    WETH: 18
                }
            }
        };
    }

    async checkLiquidity(dex, addresses) {
        const factoryABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
        const pairABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"];

        try {
            const factory = new ethers.Contract(this.DEX[dex].factory, factoryABI, this.provider);
            const pairAddress = await factory.getPair(addresses.WETH, addresses.USDC);

            const pair = new ethers.Contract(pairAddress, pairABI, this.provider);
            const [reserve0, reserve1] = await pair.getReserves();

            // Estimation simple de la liquidité
            return Number(ethers.formatUnits(reserve0, 18)) * 2000; // Prix ETH estimé
        } catch(error) {
            console.error(`Erreur liquidité ${dex}:`, error);
            return 0;
        }
    }

    async getPriceDex(dex, addresses) {
        const routerABI = ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"];
        const router = new ethers.Contract(this.DEX[dex].router, routerABI, this.provider);

        try {
            const amountIn = ethers.parseUnits("1", 18);
            const path = [addresses.WETH, addresses.USDC];

            const amounts = await router.getAmountsOut(amountIn, path);
            return Number(ethers.formatUnits(amounts[1], 6));
        } catch(error) {
            console.error(`Erreur ${dex} prix:`, error);
            return 0;
        }
    }

    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return Number(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch(error) {
            console.error('Erreur gas:', error);
            return null;
        }
    }
    async estimateFlashLoanCosts(amount = 5000) {
        try {
            // Conversion en USDC (6 decimals)
            const amountUSDC = ethers.parseUnits(amount.toString(), 6);

            // Frais de Flash Loan (généralement 0.09% sur Aave)
            const flashLoanFee = (amount * 0.0009);

            // Estimation du gas pour une transaction complète
            const estimatedGasLimit = 500000; // Gas estimé pour un flash loan + 2 swaps
            const gasPrice = await this.getGasPrice();

            // Conversion du prix du gas en USD (prix ETH approximatif)
            const ethPrice = await this.getPriceDex('camelot', this.pairs['USDC/WETH'].addresses);
            const gasCostUSD = (gasPrice * 1e-9) * estimatedGasLimit * (ethPrice);

            // Coût total
            const totalCosts = flashLoanFee + gasCostUSD;

            return {
                flashLoanFee,
                gasCostUSD,
                totalCosts
            };
        } catch(error) {
            console.error('Erreur estimation coûts:', error);
            return null;
        }
    }

      async checkOpportunities() {
        for(const [pairName, pair] of Object.entries(this.pairs)) {
            try {
                const prices = {
                    camelot: await this.getPriceDex('camelot', pair.addresses),
                    sushi: await this.getPriceDex('sushi', pair.addresses)
                };

                if(prices.camelot === 0 || prices.sushi === 0) continue;

                const liquidity = {
                    camelot: await this.checkLiquidity('camelot', pair.addresses),
                    sushi: await this.checkLiquidity('sushi', pair.addresses)
                };

                const spread = Math.abs(prices.camelot - prices.sushi) / prices.camelot * 100;
                const gasPrice = await this.getGasPrice();

                // Calculer le profit potentiel pour 5000 USDC
                const flashLoanAmount = 5000;
                const costs = await this.estimateFlashLoanCosts(flashLoanAmount);

                // Calcul du profit brut (avant frais)
                const profitBrut = (flashLoanAmount * spread) / 100;
                const profitNet = profitBrut - costs.totalCosts;

                if(spread > 0.5 && liquidity.camelot > 50000 && liquidity.sushi > 50000) {
                    console.log(`
===============================
🔍 Opportunité trouvée!
===============================
Pair: ${pairName}
Prix Camelot: $${prices.camelot}
Prix Sushi: $${prices.sushi}
Spread: ${spread.toFixed(2)}%
Liquidité Camelot: $${Math.floor(liquidity.camelot).toLocaleString()}
Liquidité Sushi: $${Math.floor(liquidity.sushi).toLocaleString()}
Gas Price: ${gasPrice} gwei

Flash Loan Analysis (pour $${flashLoanAmount}):
- Profit Brut: $${profitBrut.toFixed(2)}
- Frais Flash Loan: $${costs.flashLoanFee.toFixed(2)}
- Frais Gas (estimés): $${costs.gasCostUSD.toFixed(2)}
- Profit Net: $${profitNet.toFixed(2)}
- ROI: ${((profitNet/costs.totalCosts) * 100).toFixed(2)}%

Timestamp: ${new Date().toLocaleString()}
===============================
                    `);
                }
            } catch(error) {
                console.error(`Erreur pour ${pairName}:`, error);
            }
        }
    }

    async start() {
        console.log('🚀 Démarrage monitoring...');
        console.log('Recherche d\'opportunités...');

        while (true) {
            try {
                await this.checkOpportunities();
                await new Promise(r => setTimeout(r, 1000)); // Check toutes les secondes
            } catch(error) {
                console.error('Erreur:', error);
                await new Promise(r => setTimeout(r, 5000)); // Attendre 5s si erreur
            }
        }
    }
}

// Démarrage du monitor
const monitor = new ArbitrageMonitor();
monitor.start();