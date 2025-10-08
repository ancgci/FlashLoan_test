require('dotenv').config({ path: '../.env' }); // Carregar variáveis de ambiente do diretório pai
const { ethers } = require('ethers');

const CAMELOT_POOL_ABI = [
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

class ArbitrageMonitor {
    constructor() {
        // Verificar se a variável de ambiente ARBITRUM_RPC_URL está definida
        if (!process.env.ARBITRUM_RPC_URL) {
            throw new Error('ARBITRUM_RPC_URL não está definida nas variáveis de ambiente');
        }
        
        this.provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);

        this.ADDRESSES = {
            CAMELOT_FACTORY: "0x6EcCab422D763aC031210895C81787E87B43A652",
            SUSHI_FACTORY: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
            USDC: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
            WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
        };

        this.decimalsCache = {};
    }

    async getTokenDecimals(tokenAddress) {
        if (this.decimalsCache[tokenAddress]) {
            return this.decimalsCache[tokenAddress];
        }

        const token = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const decimals = await token.decimals();
        this.decimalsCache[tokenAddress] = decimals;
        return decimals;
    }

    async getPairAddress(factoryAddress, tokenA, tokenB) {
        const factoryABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
        const factory = new ethers.Contract(factoryAddress, factoryABI, this.provider);
        return await factory.getPair(tokenA, tokenB);
    }

    async checkLiquidity(factoryAddress, tokenA, tokenB) {
        try {
            const factoryABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];
            const factory = new ethers.Contract(factoryAddress, factoryABI, this.provider);
            const pairAddress = await factory.getPair(tokenA, tokenB);

            if (pairAddress === ethers.ZeroAddress) {
                return 0;
            }

            const pair = new ethers.Contract(pairAddress, CAMELOT_POOL_ABI, this.provider);
            const [reserve0, reserve1] = await pair.getReserves();
            const token0 = await pair.token0();

            // Obter preço atual do WETH em USDC para cálculo mais preciso
            const oneEth = ethers.parseUnits("1", 18);
            const ethPrice = await this.getPrice(
                pairAddress,
                oneEth,
                this.ADDRESSES.WETH,
                this.ADDRESSES.USDC
            );

            // Calcular a liquidez total em USD considerando ambas as reservas
            let usdcReserve, wethReserve;
            
            if (token0.toLowerCase() === this.ADDRESSES.USDC.toLowerCase()) {
                usdcReserve = reserve0;
                wethReserve = reserve1;
            } else {
                usdcReserve = reserve1;
                wethReserve = reserve0;
            }

            // Converter reservas para valores em USD
            const usdcValue = Number(ethers.formatUnits(usdcReserve, 6));
            const wethValueInUSD = Number(ethers.formatUnits(wethReserve, 18)) * Number(ethers.formatUnits(ethPrice, 6));
            
            // Retornar liquidez total em USD
            const totalLiquidityUSD = usdcValue + wethValueInUSD;
            return totalLiquidityUSD;
        } catch (error) {
            console.error('Error checking liquidity:', error);
            return 0;
        }
    }

    async getPrice(poolAddress, amountIn, tokenIn, tokenOut) {
        try {
            // Convertir amountIn en BigNumber si ce n'est pas déjà fait
            const amountInBN = ethers.getBigInt(amountIn.toString());

            const pool = new ethers.Contract(poolAddress, CAMELOT_POOL_ABI, this.provider);
            const [reserve0, reserve1] = await pool.getReserves();
            const token0 = await pool.token0();

            // Déterminer l'ordre des réserves
            const [reserveIn, reserveOut] = token0.toLowerCase() === tokenIn.toLowerCase()
                ? [reserve0, reserve1]
                : [reserve1, reserve0];

            // Calculer avec BigInt
            const amountInWithFee = (amountInBN * BigInt(997));
            const numerator = amountInWithFee * reserveOut;
            const denominator = (reserveIn * BigInt(1000)) + amountInWithFee;

            const amountOut = numerator / denominator;

            return amountOut;
        } catch (error) {
            console.error('Error getting price:', error);
            return null;
        }
    }

    async estimateProfit(amountInUSDC) {
        try {
            // Convertir le montant d'entrée en BigNumber
            const amountIn = ethers.parseUnits(amountInUSDC.toString(), 6);

            // Get pool addresses
            const camelotPool = await this.getPairAddress(
                this.ADDRESSES.CAMELOT_FACTORY,
                this.ADDRESSES.USDC,
                this.ADDRESSES.WETH
            );
            const sushiPool = await this.getPairAddress(
                this.ADDRESSES.SUSHI_FACTORY,
                this.ADDRESSES.USDC,
                this.ADDRESSES.WETH
            );

            // Get prices from both DEXes
            const camelotWETHAmount = await this.getPrice(
                camelotPool,
                amountIn,
                this.ADDRESSES.USDC,
                this.ADDRESSES.WETH
            );

            if (!camelotWETHAmount) return null;

            const sushiUSDCAmount = await this.getPrice(
                sushiPool,
                camelotWETHAmount,
                this.ADDRESSES.WETH,
                this.ADDRESSES.USDC
            );

            if (!sushiUSDCAmount) return null;

            // Calculate costs
            const gasPrice = await this.provider.getFeeData();
            const estimatedGas = ethers.parseUnits("500000", "wei");
            const gasCostWei = gasPrice.gasPrice * BigInt(estimatedGas);

            // Get ETH price for gas calculation
            const oneEth = ethers.parseUnits("1", 18);
            const ethPrice = await this.getPrice(
                camelotPool,
                oneEth,
                this.ADDRESSES.WETH,
                this.ADDRESSES.USDC
            );

            const gasCostUSDC = (gasCostWei * BigInt(ethPrice)) / oneEth;

            // Calculate flash loan fee (0.09%)
            const flashLoanFee = (amountIn * BigInt(9)) / BigInt(10000);

            // Adicionar consideração de slippage (0.5%)
            const slippageTolerance = 0.005; // 0.5%
            const minAmountOut = (BigInt(sushiUSDCAmount) * BigInt(1000 - Math.floor(slippageTolerance * 1000))) / BigInt(1000);

            // Calculate total profit
            const profitUSDC = BigInt(minAmountOut) - BigInt(amountIn) - BigInt(gasCostUSDC) - BigInt(flashLoanFee);

            // Check liquidity
            const liquidityCamelot = await this.checkLiquidity(
                this.ADDRESSES.CAMELOT_FACTORY,
                this.ADDRESSES.USDC,
                this.ADDRESSES.WETH
            );
            
            const liquiditySushi = await this.checkLiquidity(
                this.ADDRESSES.SUSHI_FACTORY,
                this.ADDRESSES.USDC,
                this.ADDRESSES.WETH
            );

            return {
                amountIn: ethers.formatUnits(amountIn, 6),
                camelotWETHAmount: ethers.formatUnits(camelotWETHAmount, 18),
                sushiUSDCAmount: ethers.formatUnits(sushiUSDCAmount, 6),
                minAmountOut: ethers.formatUnits(minAmountOut, 6), // Valor após slippage
                gasCost: ethers.formatUnits(gasCostUSDC, 6),
                flashLoanFee: ethers.formatUnits(flashLoanFee, 6),
                profit: ethers.formatUnits(profitUSDC, 6),
                profitPercentage: Number(((profitUSDC * BigInt(10000)) / amountIn).toString()) / 100,
                liquidityCamelot,
                liquiditySushi,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('Error estimating profit:', error);
            return null;
        }
    }

    async monitorOpportunities() {
        const amounts = [1000, 5000, 10000, 20000];

        console.log('🔍 Monitoring arbitrage opportunities...\n');

        while (true) {
            for (const amount of amounts) {
                const result = await this.estimateProfit(amount);

                if (result && parseFloat(result.profit) > 0) {
                    console.log(`
===============================
💰 Profitable Opportunity Found!
===============================
Amount In: ${result.amountIn} USDC
WETH received from Camelot: ${result.camelotWETHAmount} WETH
USDC received from Sushi: ${result.sushiUSDCAmount} USDC
USDC after slippage: ${result.minAmountOut} USDC
Gas Cost: ${result.gasCost} USDC
Flash Loan Fee: ${result.flashLoanFee} USDC
Net Profit: ${result.profit} USDC
ROI: ${result.profitPercentage}%
Liquidity Camelot: $${Math.floor(result.liquidityCamelot).toLocaleString()}
Liquidity Sushi: $${Math.floor(result.liquiditySushi).toLocaleString()}
Timestamp: ${result.timestamp}
===============================
                    `);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Start monitoring
const monitor = new ArbitrageMonitor();
monitor.monitorOpportunities();