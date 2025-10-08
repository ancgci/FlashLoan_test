// monitor.js
require('dotenv').config({ path: '../../.env' });
const { ethers } = require('ethers');

class ArbitrageMonitor {
    constructor() {
        // RPC Arbitrum
        this.provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);

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
        const pairABI = [
            "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
            "function token0() view returns (address)"
        ];

        try {
            const factory = new ethers.Contract(this.DEX[dex].factory, factoryABI, this.provider);
            const pairAddress = await factory.getPair(addresses.WETH, addresses.USDC);

            if (pairAddress === ethers.ZeroAddress) {
                return 0;
            }

            const pair = new ethers.Contract(pairAddress, pairABI, this.provider);
            const [reserve0, reserve1] = await pair.getReserves();
            const token0 = await pair.token0(); // Chamando corretamente como função

            // Obter preço atual do WETH em USDC para cálculo mais preciso
            const oneEth = ethers.parseUnits("1", 18);
            const ethPrice = await this.getPriceDex('camelot', addresses);
            
            // Calcular a liquidez total em USD considerando ambas as reservas
            let usdcReserve, wethReserve;
            
            if (token0.toLowerCase() === addresses.USDC.toLowerCase()) {
                usdcReserve = reserve0;
                wethReserve = reserve1;
            } else {
                usdcReserve = reserve1;
                wethReserve = reserve0;
            }

            // Converter reservas para valores em USD
            const usdcValue = Number(ethers.formatUnits(usdcReserve, 6));
            const wethValueInUSD = Number(ethers.formatUnits(wethReserve, 18)) * ethPrice;
            
            // Retornar liquidez total em USD
            const totalLiquidityUSD = usdcValue + wethValueInUSD;
            return totalLiquidityUSD;
        } catch(error) {
            console.error(`Erro de liquidez ${dex}:`, error);
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
            console.error(`Erro ${dex} preço:`, error);
            return 0;
        }
    }

    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return Number(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch(error) {
            console.error('Erro gas:', error);
            return null;
        }
    }
    async estimateFlashLoanCosts(amount = 5000) {
        try {
            // Conversão para USDC (6 decimais)
            const amountUSDC = ethers.parseUnits(amount.toString(), 6);

            // Taxas de Flash Loan (geralmente 0,09% na Aave)
            const flashLoanFee = (amount * 0.0009);

            // Estimativa de gas para uma transação completa
            const estimatedGasLimit = 500000; // Gas estimado para um flash loan + 2 swaps
            const gasPrice = await this.getGasPrice();

            // Conversão do preço do gas para USD (preço ETH aproximado)
            const ethPrice = await this.getPriceDex('camelot', this.pairs['USDC/WETH'].addresses);
            const gasCostUSD = (gasPrice * 1e-9) * estimatedGasLimit * (ethPrice);

            // Custo total
            const totalCosts = flashLoanFee + gasCostUSD;

            return {
                flashLoanFee,
                gasCostUSD,
                totalCosts
            };
        } catch(error) {
            console.error('Erro estimativa custos:', error);
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

                // Calcular o lucro potencial para 5000 USDC
                const flashLoanAmount = 5000;
                const costs = await this.estimateFlashLoanCosts(flashLoanAmount);

                // Cálculo do lucro bruto (antes das taxas)
                const profitBrut = (flashLoanAmount * spread) / 100;
                
                // Aplicar slippage de 0.5% para cálculo mais realista
                const slippageTolerance = 0.005; // 0.5%
                const profitAfterSlippage = profitBrut * (1 - slippageTolerance);
                
                const profitNet = profitAfterSlippage - costs.totalCosts;

                if(spread > 0.5 && liquidity.camelot > 50000 && liquidity.sushi > 50000) {
                    console.log(`
===============================
🔍 Oportunidade encontrada!
===============================
Par: ${pairName}
Preço Camelot: $${prices.camelot}
Preço Sushi: $${prices.sushi}
Spread: ${spread.toFixed(2)}%
Liquidez Camelot: $${Math.floor(liquidity.camelot).toLocaleString()}
Liquidez Sushi: $${Math.floor(liquidity.sushi).toLocaleString()}
Preço do Gas: ${gasPrice} gwei

Análise Flash Loan (para $${flashLoanAmount}):
- Lucro Bruto: $${profitBrut.toFixed(2)}
- Lucro após Slippage (0.5%): $${profitAfterSlippage.toFixed(2)}
- Taxa Flash Loan: $${costs.flashLoanFee.toFixed(2)}
- Taxa Gas (estimada): $${costs.gasCostUSD.toFixed(2)}
- Lucro Líquido: $${profitNet.toFixed(2)}
- ROI: ${((profitNet/costs.totalCosts) * 100).toFixed(2)}%

Timestamp: ${new Date().toLocaleString()}
===============================
                    `);
                }
            } catch(error) {
                console.error(`Erro para ${pairName}:`, error);
            }
        }
    }

    async start() {
        console.log('🚀 Iniciando monitoramento...');
        console.log('Procurando oportunidades...');

        while (true) {
            try {
                await this.checkOpportunities();
                await new Promise(r => setTimeout(r, 1000)); // Verifica a cada segundo
            } catch(error) {
                console.error('Erro:', error);
                await new Promise(r => setTimeout(r, 5000)); // Aguarda 5s em caso de erro
            }
        }
    }
}

// Démarrage du monitor
const monitor = new ArbitrageMonitor();
monitor.start();