// arbitrage-bot.js - Bot completo de monitoramento e execução de arbitragem
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const CONFIG = {
    // RPC e Carteira
    RPC_URL: process.env.RPC_URL || process.env.ARBITRUM_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    FLASHLOAN_CONTRACT_ADDRESS: process.env.FLASHLOAN_CONTRACT_ADDRESS,

    // Tokens expandidos
    TOKENS: {
        USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        WIF: '0x12b535631ae4431c909e775e610e7391e16a09e7', // Dogwifhat
        // Adicionar outros memecoins conforme identificados
    },

    // Pares verificados que existem nas DEXs
    TRADING_PAIRS: [
        { tokenIn: 'USDC', tokenOut: 'WETH' }, // Existe em ambas DEXs
        { tokenIn: 'WETH', tokenOut: 'WIF' }, // Existe apenas no Sushi
        // Adicionar mais combinações conforme verificado
    ],

    // Parâmetros específicos para memecoins (mais voláteis)
    MEMECOIN_PARAMS: {
        MIN_PROFIT_PERCENTAGE: 1.0, // Maior margem de lucro devido à volatilidade
        MIN_LIQUIDITY_USD: 10000,   // Liquidez mínima menor para tokens menores
        SLIPPAGE_TOLERANCE: 0.02,   // Maior tolerância de slippage (2%)
        CHECK_INTERVAL: 5000,       // Verificação mais frequente (5 segundos)
    },

    // DEX
    DEX: {
        camelot: {
            router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
            factory: "0x6EcCab422D763aC031210895C81787E87B43A652"
        },
        sushi: {
            router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
            factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4"
        }
    },

    // Parâmetros de trading padrão
    FLASH_LOAN_AMOUNTS: [1000, 5000, 10000], // Valores em USDC para testar
    MIN_PROFIT_PERCENTAGE: 0.5, // 0.5% mínimo
    MIN_LIQUIDITY_USD: 50000, // Liquidez mínima por DEX
    CHECK_INTERVAL: 10000, // Verificar a cada 10 segundos
    MAX_LOSS_PERCENTAGE: 0.1, // 0.1% máximo de perda permitida

    // Execução
    AUTO_EXECUTE: false, // true = executa automaticamente, false = apenas log
    MAX_GAS_PRICE_GWEI: 0.5, // Preço máximo do gas na Arbitrum
    DRY_RUN: true, // true = simulação apenas
    ADVANCED_SIMULATION: true, // true = simulação avançada com verificação de slippage
};

// ═══════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

const POOL_ABI = [
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) view returns (address pair)"
];

const FLASHLOAN_ABI = [
    'function requestFlashLoan(address token, uint256 amount) external',
    'function getBalance(address token) external view returns (uint256)',
    'function owner() external view returns (address)'
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)"
];

// ═══════════════════════════════════════════════════════
// ARBITRAGE BOT CLASS
// ═══════════════════════════════════════════════════════

class ArbitrageBot {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        this.wallet = CONFIG.PRIVATE_KEY ? new ethers.Wallet(CONFIG.PRIVATE_KEY, this.provider) : null;

        // Cache inteligente
        this.cache = new SmartCache();

        // Cache
        this.decimalsCache = {};
        this.lastOpportunity = null;
        this.stats = {
            checksPerformed: 0,
            opportunitiesFound: 0,
            tradesExecuted: 0,
            totalProfit: 0,
            startTime: Date.now()
        };

        // Contracts
        this.initContracts();
    }

    initContracts() {
        // DEX Routers
        this.camelotRouter = new ethers.Contract(
            CONFIG.DEX.camelot.router,
            ROUTER_ABI,
            this.provider
        );

        this.sushiswapRouter = new ethers.Contract(
            CONFIG.DEX.sushi.router,
            ROUTER_ABI,
            this.provider
        );

        // Factories
        this.camelotFactory = new ethers.Contract(
            CONFIG.DEX.camelot.factory,
            FACTORY_ABI,
            this.provider
        );

        this.sushiFactory = new ethers.Contract(
            CONFIG.DEX.sushi.factory,
            FACTORY_ABI,
            this.provider
        );

        // FlashLoan contract (si disponível)
        if (CONFIG.FLASHLOAN_CONTRACT_ADDRESS && this.wallet) {
            this.flashLoanContract = new ethers.Contract(
                CONFIG.FLASHLOAN_CONTRACT_ADDRESS,
                FLASHLOAN_ABI,
                this.wallet
            );
        }
    }

    // ═══════════════════════════════════════════════════════
    // PREÇO E LIQUIDEZ
    // ═══════════════════════════════════════════════════════

    /**
     * Obter preço via roteador (método simples)
     */
    async getPriceViaRouter(router, tokenIn, tokenOut, amountIn) {
        try {
            const path = [tokenIn, tokenOut];
            const amounts = await router.getAmountsOut(amountIn, path);
            return amounts[1];
        } catch (error) {
            console.error(`Erro getPriceViaRouter:`, error.message);
            return null;
        }
    }

    /**
     * Obter preço via pool diretamente (mais preciso, leva em conta as taxas)
     */
    async getPriceViaPool(poolAddress, amountIn, tokenIn, tokenOut) {
        try {
            const amountInBN = ethers.getBigInt(amountIn.toString());
            const pool = new ethers.Contract(poolAddress, POOL_ABI, this.provider);

            const [reserve0, reserve1] = await pool.getReserves();
            const token0 = await pool.token0();

            // Determinar a ordem das reservas
            const [reserveIn, reserveOut] = token0.toLowerCase() === tokenIn.toLowerCase()
                ? [reserve0, reserve1]
                : [reserve1, reserve0];

            // Fórmula Uniswap V2 com taxa de 0.3%
            const amountInWithFee = (amountInBN * BigInt(997));
            const numerator = amountInWithFee * reserveOut;
            const denominator = (reserveIn * BigInt(1000)) + amountInWithFee;

            const amountOut = numerator / denominator;
            return amountOut;
        } catch (error) {
            console.error('Erro getPriceViaPool:', error.message);
            return null;
        }
    }

    /**
     * Verificar a liquidez de um pool
     */
    async checkLiquidity(factory, tokenA, tokenB) {
        try {
            const pairAddress = await factory.getPair(tokenA, tokenB);

            if (pairAddress === ethers.ZeroAddress) {
                return 0;
            }

            const pair = new ethers.Contract(pairAddress, POOL_ABI, this.provider);
            const [reserve0, reserve1] = await pair.getReserves();
            const token0 = await pair.token0();

            // Obter preço atual do WETH em USDC para cálculo mais preciso
            const oneEth = ethers.parseUnits("1", 18);
            const ethPriceUSDC = await this.getPriceViaRouter(
                this.camelotRouter,
                CONFIG.TOKENS.WETH,
                CONFIG.TOKENS.USDC,
                oneEth
            );

            // Calcular a liquidez total em USD considerando ambas as reservas
            let usdcReserve, wethReserve;
            
            if (token0.toLowerCase() === CONFIG.TOKENS.USDC.toLowerCase()) {
                usdcReserve = reserve0;
                wethReserve = reserve1;
            } else {
                usdcReserve = reserve1;
                wethReserve = reserve0;
            }

            // Converter reservas para valores em USD
            const usdcValue = Number(ethers.formatUnits(usdcReserve, 6));
            const wethValueInUSD = Number(ethers.formatUnits(wethReserve, 18)) * Number(ethers.formatUnits(ethPriceUSDC, 6));
            
            // Retornar liquidez total em USD
            const totalLiquidityUSD = usdcValue + wethValueInUSD;
            
            // Para memecoins, considerar volatilidade:
            // Verificar se algum dos tokens é um memecoin
            const isMemecoinPair = Object.values(CONFIG.TOKENS).slice(2).some(token => 
                token === tokenA || token === tokenB
            );
            
            if (isMemecoinPair) {
                // Para memecoins, considerar liquidez efetiva ajustada pela volatilidade
                // Esta é uma simplificação - em produção, seria mais complexo
                const volatilityFactor = 0.1; // Fator de ajuste fixo para exemplo
                const adjustedLiquidity = totalLiquidityUSD * (1 - volatilityFactor);
                return adjustedLiquidity;
            }
            
            return totalLiquidityUSD;
        } catch (error) {
            console.error('Erro checkLiquidity:', error.message);
            return 0;
        }
    }

    /**
     * Verificar a volatilidade dos preços
     */
    async checkPriceVolatility(tokenIn, tokenOut, amount) {
        try {
            // Obter preços em diferentes momentos
            const price1 = await this.getPriceViaRouter(this.camelotRouter, tokenIn, tokenOut, amount);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Aguardar 1 segundo
            const price2 = await this.getPriceViaRouter(this.camelotRouter, tokenIn, tokenOut, amount);
            
            if (!price1 || !price2) return 0;
            
            // Calcular a variação percentual
            const variation = Math.abs(Number(price2) - Number(price1)) / Number(price1) * 100;
            return variation;
        } catch (error) {
            console.error('Erro checkPriceVolatility:', error.message);
            return 0;
        }
    }

    /**
     * Verificar volatilidade do token para identificar oportunidades em memecoins
     */
    async checkTokenVolatility(tokenAddress, timeWindow = 3600000) {
        try {
            // Verificar se temos dados em cache
            const cacheKey = `volatility_${tokenAddress}_${timeWindow}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) {
                return cached;
            }

            // Obter histórico de preços nas últimas X horas
            const currentTime = Date.now();
            const pastTime = currentTime - timeWindow;
            
            // Para simplificação, vamos usar uma abordagem básica de volatilidade
            // baseada em mudanças de preço nos últimos 5 minutos
            const testAmount = ethers.parseUnits("1", 18); // 1 unidade do token
            
            // Obter preços em diferentes momentos
            const prices = [];
            for (let i = 0; i < 5; i++) {
                const price = await this.getPriceViaRouter(
                    this.camelotRouter, 
                    tokenAddress, 
                    CONFIG.TOKENS.USDC, 
                    testAmount
                );
                if (price) {
                    prices.push(Number(ethers.formatUnits(price, 6)));
                }
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1 segundo entre leituras
            }
            
            if (prices.length < 2) return 0;
            
            // Calcular volatilidade como desvio padrão dos retornos
            const returns = [];
            for (let i = 1; i < prices.length; i++) {
                const ret = (prices[i] - prices[i-1]) / prices[i-1];
                returns.push(ret);
            }
            
            // Calcular média dos retornos
            const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
            
            // Calcular desvio padrão
            const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
            const volatility = Math.sqrt(variance) * Math.sqrt(returns.length); // Anualizar (simplificado)
            
            // Converter para pontuação de 0-100
            const volatilityScore = Math.min(100, volatility * 1000); // Ajustar escala
            
            // Armazenar em cache por 30 segundos
            this.cache.set(cacheKey, volatilityScore, 30000);
            
            return volatilityScore;
        } catch (error) {
            console.error('Erro ao verificar volatilidade:', error.message);
            return 0;
        }
    }

    /**
     * Verificar tendência do mercado para o token
     */
    async checkTokenTrend(tokenAddress) {
        try {
            // Verificar se temos dados em cache
            const cacheKey = `trend_${tokenAddress}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== null) {
                return cached;
            }

            // Analisar movimento de preços nas últimas 24h (simulado com 5 minutos para teste)
            const testAmount = ethers.parseUnits("1", 18); // 1 unidade do token
            
            // Obter preços no início e no fim do período
            const priceStart = await this.getPriceViaRouter(
                this.camelotRouter, 
                tokenAddress, 
                CONFIG.TOKENS.USDC, 
                testAmount
            );
            
            await new Promise(resolve => setTimeout(resolve, 5000)); // Aguardar 5 segundos
            
            const priceEnd = await this.getPriceViaRouter(
                this.camelotRouter, 
                tokenAddress, 
                CONFIG.TOKENS.USDC, 
                testAmount
            );
            
            if (!priceStart || !priceEnd) {
                this.cache.set(cacheKey, 'NEUTRAL', 60000); // Cache por 1 minuto
                return 'NEUTRAL';
            }
            
            const startPrice = Number(ethers.formatUnits(priceStart, 6));
            const endPrice = Number(ethers.formatUnits(priceEnd, 6));
            
            const changePercent = ((endPrice - startPrice) / startPrice) * 100;
            
            let trend;
            if (changePercent > 2) {
                trend = 'BULLISH'; // Tendência de alta
            } else if (changePercent < -2) {
                trend = 'BEARISH'; // Tendência de baixa
            } else {
                trend = 'NEUTRAL'; // Sem tendência clara
            }
            
            // Armazenar em cache por 1 minuto
            this.cache.set(cacheKey, trend, 60000);
            
            return trend;
        } catch (error) {
            console.error('Erro ao verificar tendência:', error.message);
            return 'NEUTRAL';
        }
    }

    /**
     * Obter o preço atual do gas
     */
    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return Number(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch (error) {
            console.error('Erro getGasPrice:', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════
    // ANÁLISE DE OPORTUNIDADES
    // ═══════════════════════════════════════════════════════

    /**
     * Estimar o lucro para um valor dado
     */
    async estimateProfit(amountInUSDC, tokenInSymbol = 'USDC', tokenOutSymbol = 'WETH') {
        try {
            // Determinar se é um par de memecoin
            const isMemecoinPair = tokenOutSymbol === 'WIF';
            
            // Usar parâmetros específicos para memecoins se necessário
            const minProfitPercentage = isMemecoinPair ? 
                CONFIG.MEMECOIN_PARAMS.MIN_PROFIT_PERCENTAGE : 
                CONFIG.MIN_PROFIT_PERCENTAGE;
                
            const slippageTolerance = isMemecoinPair ? 
                CONFIG.MEMECOIN_PARAMS.SLIPPAGE_TOLERANCE : 
                0.005; // 0.5% padrão

            const tokenIn = CONFIG.TOKENS[tokenInSymbol];
            const tokenOut = CONFIG.TOKENS[tokenOutSymbol];
            
            if (!tokenIn || !tokenOut) {
                console.error(`Tokens não encontrados: ${tokenInSymbol}/${tokenOutSymbol}`);
                return null;
            }

            const amountIn = ethers.parseUnits(amountInUSDC.toString(), 
                tokenInSymbol === 'USDC' ? 6 : 18);

            // 1. Preço tokenIn -> tokenOut na Camelot
            const camelotTokenOutAmount = await this.getPriceViaRouter(
                this.camelotRouter,
                tokenIn,
                tokenOut,
                amountIn
            );

            if (!camelotTokenOutAmount || camelotTokenOutAmount === 0n) return null;

            // 2. Preço tokenOut -> tokenIn na Sushiswap
            const sushiTokenInAmount = await this.getPriceViaRouter(
                this.sushiswapRouter,
                tokenOut,
                tokenIn,
                camelotTokenOutAmount
            );

            if (!sushiTokenInAmount || sushiTokenInAmount === 0n) return null;

            // 3. Verificar volatilidade dos preços
            const volatility = await this.checkPriceVolatility(tokenIn, tokenOut, amountIn);
            if (volatility > 5) { // Se a volatilidade for maior que 5%, não considerar
                console.log(`⚠️  Alta volatilidade detectada (${volatility.toFixed(2)}%), pulando oportunidade`);
                return null;
            }

            // 4. Calcular os custos
            const gasPrice = await this.provider.getFeeData();
            
            // Estimar o gas de forma mais precisa usando o contrato real
            let estimatedGas = 500000n; // Gas estimado padrão
            if (this.flashLoanContract) {
                try {
                    estimatedGas = await this.flashLoanContract.requestFlashLoan.estimateGas(
                        tokenIn,
                        amountIn
                    );
                    estimatedGas = (estimatedGas * 120n) / 100n; // +20% de margem de segurança
                } catch (error) {
                    console.log('⚠️ Impossível estimar o gas, utilizando o limite padrão');
                }
            }

            const gasCostWei = gasPrice.gasPrice * estimatedGas;

            // Preço ETH para cálculo do gas em tokenIn
            const oneEth = ethers.parseUnits("1", 18);
            const ethPriceTokenIn = await this.getPriceViaRouter(
                this.camelotRouter,
                CONFIG.TOKENS.WETH,
                tokenIn,
                oneEth
            );

            const gasCostTokenIn = (gasCostWei * ethPriceTokenIn) / oneEth;

            // Taxa de flash loan AAVE = 0.09%
            const flashLoanFee = (amountIn * 9n) / 10000n;

            // Adicionar consideração de slippage
            const minAmountOut = (sushiTokenInAmount * (1000n - BigInt(Math.floor(slippageTolerance * 1000)))) / 1000n;
            
            // 5. Lucro líquido
            const profitTokenIn = minAmountOut - amountIn - gasCostTokenIn - flashLoanFee;
            
            // 6. Calcular porcentagem de lucro/perda
            const profitPercentage = (Number(profitTokenIn) / Number(amountIn)) * 100;
            
            // 7. Verificar se a perda está dentro do limite permitido
            if (profitPercentage < -CONFIG.MAX_LOSS_PERCENTAGE) {
                console.log(`⚠️  Perda potencial muito alta (${profitPercentage.toFixed(3)}%), pulando oportunidade`);
                return null;
            }

            // Verificar a liquidez
            const liquidityCamelot = await this.checkLiquidity(
                this.camelotFactory,
                tokenIn,
                tokenOut
            );

            const liquiditySushi = await this.checkLiquidity(
                this.sushiFactory,
                tokenIn,
                tokenOut
            );

            // Verificar tendência do token se for memecoin
            let tokenTrend = 'NEUTRAL';
            if (isMemecoinPair) {
                tokenTrend = await this.checkTokenTrend(tokenOut);
            }

            return {
                tokenInSymbol,
                tokenOutSymbol,
                amountIn: Number(ethers.formatUnits(amountIn, tokenInSymbol === 'USDC' ? 6 : 18)),
                camelotTokenOutAmount: Number(ethers.formatUnits(camelotTokenOutAmount, tokenOutSymbol === 'USDC' ? 6 : 18)),
                sushiTokenInAmount: Number(ethers.formatUnits(sushiTokenInAmount, tokenInSymbol === 'USDC' ? 6 : 18)),
                minAmountOut: Number(ethers.formatUnits(minAmountOut, tokenInSymbol === 'USDC' ? 6 : 18)), // Valor após slippage
                gasCost: Number(ethers.formatUnits(gasCostTokenIn, tokenInSymbol === 'USDC' ? 6 : 18)),
                flashLoanFee: Number(ethers.formatUnits(flashLoanFee, tokenInSymbol === 'USDC' ? 6 : 18)),
                profit: Number(ethers.formatUnits(profitTokenIn, tokenInSymbol === 'USDC' ? 6 : 18)),
                profitPercentage: profitPercentage,
                liquidityCamelot,
                liquiditySushi,
                gasPriceGwei: Number(ethers.formatUnits(gasPrice.gasPrice, 'gwei')),
                volatility: volatility,
                tokenTrend: tokenTrend,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('Erro estimateProfit:', error.message);
            return null;
        }
    }

    /**
     * Verificar todas as oportunidades para diferentes valores e pares
     */
    async checkOpportunities() {
        this.stats.checksPerformed++;
        const opportunities = [];

        // Verificar todos os pares de trading configurados
        for (const pair of CONFIG.TRADING_PAIRS) {
            for (const amount of CONFIG.FLASH_LOAN_AMOUNTS) {
                const result = await this.estimateProfit(amount, pair.tokenIn, pair.tokenOut);

                if (result && result.profit > 0) {
                    opportunities.push(result);
                }
            }
        }

        return opportunities;
    }

    // ═══════════════════════════════════════════════════════
    // EXECUÇÃO
    // ═══════════════════════════════════════════════════════

    /**
     * Executar a arbitragem via smart contract
     */
    async executeArbitrage(opportunity) {
        if (!this.flashLoanContract) {
            console.log('❌ Contrato FlashLoan não configurado');
            return false;
        }

        if (CONFIG.DRY_RUN) {
            console.log('🧪 DRY RUN - Transação não enviada');
            return false;
        }

        try {
            console.log('\n🚀 EXECUÇÃO DA ARBITRAGEM...');

            const amountTokenIn = ethers.parseUnits(opportunity.amountIn.toString(), 
                opportunity.tokenInSymbol === 'USDC' ? 6 : 18);

            // Verificar o owner
            const owner = await this.flashLoanContract.owner();
            if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
                console.log(`❌ Você não é o owner do contrato`);
                console.log(`   Owner: ${owner}`);
                console.log(`   Seu endereço: ${this.wallet.address}`);
                return false;
            }

            // Estimar o gas
            let gasLimit;
            try {
                gasLimit = await this.flashLoanContract.requestFlashLoan.estimateGas(
                    CONFIG.TOKENS[opportunity.tokenInSymbol],
                    amountTokenIn
                );
                gasLimit = (gasLimit * 120n) / 100n; // +20% de margem
            } catch (error) {
                console.log('⚠️ Impossível estimar o gas, utilizando o limite padrão');
                gasLimit = 1000000n;
            }

            // Enviar a transação
            console.log('📤 Enviando a transação...');
            const tx = await this.flashLoanContract.requestFlashLoan(
                CONFIG.TOKENS[opportunity.tokenInSymbol],
                amountTokenIn,
                {
                    gasLimit: gasLimit
                }
            );

            console.log(`📝 Tx Hash: ${tx.hash}`);
            console.log('⏳ Aguardando confirmação...');

            const receipt = await tx.wait();

            if (receipt.status === 1) {
                console.log('✅ Transação bem-sucedida!');

                // Verificar o lucro real
                const balanceAfter = await this.flashLoanContract.getBalance(CONFIG.TOKENS[opportunity.tokenInSymbol]);
                console.log(`💰 Saldo após: ${ethers.formatUnits(balanceAfter, opportunity.tokenInSymbol === 'USDC' ? 6 : 18)} ${opportunity.tokenInSymbol}`);

                this.stats.tradesExecuted++;
                this.stats.totalProfit += opportunity.profit;

                this.logTrade(opportunity, tx.hash, true);
                return true;
            } else {
                console.log('❌ Transação falhou');
                this.logTrade(opportunity, tx.hash, false);
                return false;
            }

        } catch (error) {
            console.error('❌ Erro durante a execução:', error.message);

            if (error.message.includes('Arbitrage not profitable')) {
                console.log('⚠️ O contrato determinou que a arbitragem não é lucrativa');
            }

            return false;
        }
    }

    /**
     * Registrar as operações em um arquivo
     */
    logTrade(opportunity, txHash, success) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            tokenIn: opportunity.tokenInSymbol,
            tokenOut: opportunity.tokenOutSymbol,
            amount: opportunity.amountIn,
            expectedProfit: opportunity.profit,
            profitPercentage: opportunity.profitPercentage,
            txHash,
            success,
            gasCost: opportunity.gasCost,
            flashLoanFee: opportunity.flashLoanFee,
            volatility: opportunity.volatility,
            liquidityCamelot: opportunity.liquidityCamelot,
            liquiditySushi: opportunity.liquiditySushi
        };

        fs.appendFileSync(
            'trades.log',
            JSON.stringify(logEntry) + '\n'
        );
    }

    /**
     * Registrar oportunidades em um arquivo de log detalhado
     */
    logOpportunity(opportunity) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            tokenIn: opportunity.tokenInSymbol,
            tokenOut: opportunity.tokenOutSymbol,
            amountIn: opportunity.amountIn,
            camelotTokenOutAmount: opportunity.camelotTokenOutAmount,
            sushiTokenInAmount: opportunity.sushiTokenInAmount,
            minAmountOut: opportunity.minAmountOut,
            gasCost: opportunity.gasCost,
            flashLoanFee: opportunity.flashLoanFee,
            profit: opportunity.profit,
            profitPercentage: opportunity.profitPercentage,
            liquidityCamelot: opportunity.liquidityCamelot,
            liquiditySushi: opportunity.liquiditySushi,
            gasPriceGwei: opportunity.gasPriceGwei,
            volatility: opportunity.volatility,
            tokenTrend: opportunity.tokenTrend
        };

        fs.appendFileSync(
            'opportunities.log',
            JSON.stringify(logEntry) + '\n'
        );
    }

    /**
     * Simular execução de arbitragem sem enviar transação
     */
    async simulateArbitrage(opportunity) {
        console.log('\n🧪 SIMULAÇÃO DE ARBITRAGEM AVANÇADA');
        console.log(`${'═'.repeat(50)}`);
        
        try {
            // Simular o processo completo de arbitragem
            const amountIn = ethers.parseUnits(opportunity.amountIn.toString(), 
                opportunity.tokenInSymbol === 'USDC' ? 6 : 18);
            
            // 1. Simular flash loan
            console.log(`📥 Flash Loan: ${opportunity.amountIn} ${opportunity.tokenInSymbol}`);
            
            // 2. Simular swap na Camelot
            console.log(`🔄 Swap Camelot: ${opportunity.amountIn} ${opportunity.tokenInSymbol} → ${opportunity.camelotTokenOutAmount.toFixed(6)} ${opportunity.tokenOutSymbol}`);
            
            // 3. Simular swap na Sushiswap
            console.log(`🔄 Swap Sushiswap: ${opportunity.camelotTokenOutAmount.toFixed(6)} ${opportunity.tokenOutSymbol} → ${opportunity.sushiTokenInAmount} ${opportunity.tokenInSymbol}`);
            
            // 4. Calcular custos
            console.log(`💸 Taxa Flash Loan (0.09%): ${opportunity.flashLoanFee.toFixed(2)} ${opportunity.tokenInSymbol}`);
            console.log(`⛽ Custo de Gas: ${opportunity.gasCost.toFixed(2)} ${opportunity.tokenInSymbol}`);
            
            // 5. Calcular lucro líquido
            console.log(`💰 Lucro Líquido: ${opportunity.profit.toFixed(2)} ${opportunity.tokenInSymbol}`);
            console.log(`📊 ROI: ${opportunity.profitPercentage.toFixed(3)}%`);
            
            // 6. Verificar liquidez
            console.log(`🏊 Liquidez Camelot: $${Math.floor(opportunity.liquidityCamelot).toLocaleString()}`);
            console.log(`🏊 Liquidez Sushiswap: $${Math.floor(opportunity.liquiditySushi).toLocaleString()}`);
            
            // 7. Verificar volatilidade
            console.log(`🌪️ Volatilidade: ${opportunity.volatility.toFixed(2)}%`);
            
            // 8. Verificar tendência do token (se for memecoin)
            if (opportunity.tokenTrend) {
                console.log(`📈 Tendência: ${opportunity.tokenTrend}`);
            }
            
            // 9. Verificar se é lucrativo
            const isMemecoinPair = opportunity.tokenOutSymbol === 'WIF';
            const minProfitPercentage = isMemecoinPair ? 
                CONFIG.MEMECOIN_PARAMS.MIN_PROFIT_PERCENTAGE : 
                CONFIG.MIN_PROFIT_PERCENTAGE;
                
            if (opportunity.profit > 0 && opportunity.profitPercentage >= minProfitPercentage) {
                console.log(`✅ Simulação lucrativa!`);
                
                // Registrar simulação em log
                const simulationLog = {
                    timestamp: new Date().toISOString(),
                    type: 'simulation',
                    tokenIn: opportunity.tokenInSymbol,
                    tokenOut: opportunity.tokenOutSymbol,
                    amountIn: opportunity.amountIn,
                    profit: opportunity.profit,
                    profitPercentage: opportunity.profitPercentage,
                    liquidityCamelot: opportunity.liquidityCamelot,
                    liquiditySushi: opportunity.liquiditySushi,
                    volatility: opportunity.volatility,
                    tokenTrend: opportunity.tokenTrend,
                    status: 'profitable'
                };
                
                fs.appendFileSync('simulations.log', JSON.stringify(simulationLog) + '\n');
            } else {
                console.log(`❌ Simulação não lucrativa`);
                
                // Registrar simulação em log
                const simulationLog = {
                    timestamp: new Date().toISOString(),
                    type: 'simulation',
                    tokenIn: opportunity.tokenInSymbol,
                    tokenOut: opportunity.tokenOutSymbol,
                    amountIn: opportunity.amountIn,
                    profit: opportunity.profit,
                    profitPercentage: opportunity.profitPercentage,
                    liquidityCamelot: opportunity.liquidityCamelot,
                    liquiditySushi: opportunity.liquiditySushi,
                    volatility: opportunity.volatility,
                    tokenTrend: opportunity.tokenTrend,
                    status: 'unprofitable'
                };
                
                fs.appendFileSync('simulations.log', JSON.stringify(simulationLog) + '\n');
            }
            
            console.log(`${'═'.repeat(50)}\n`);
            
        } catch (error) {
            console.error('❌ Erro na simulação:', error.message);
        }
    }

    // ═══════════════════════════════════════════════════════
    // MONITORAMENTO E EXIBIÇÃO
    // ═══════════════════════════════════════════════════════

    /**
     * Exibir uma oportunidade encontrada
     */
    displayOpportunity(opportunity) {
        this.stats.opportunitiesFound++;

        // Registrar oportunidade em log detalhado
        this.logOpportunity(opportunity);

        console.log(`
${'═'.repeat(60)}
💰 OPORTUNIDADE DE ARBITRAGEM DETECTADA!
${'═'.repeat(60)}
📊 Valores:
   • Flash Loan: ${opportunity.amountIn.toFixed(2)} ${opportunity.tokenInSymbol}
   • ${opportunity.tokenOutSymbol} recebido (Camelot): ${opportunity.camelotTokenOutAmount.toFixed(6)} ${opportunity.tokenOutSymbol}
   • ${opportunity.tokenInSymbol} final (Sushiswap): ${opportunity.sushiTokenInAmount.toFixed(2)} ${opportunity.tokenInSymbol}
   • ${opportunity.tokenInSymbol} após slippage: ${opportunity.minAmountOut.toFixed(2)} ${opportunity.tokenInSymbol}

💵 Custos:
   • Taxa Flash Loan (0.09%): ${opportunity.flashLoanFee.toFixed(2)} ${opportunity.tokenInSymbol}
   • Gas estimado: ${opportunity.gasCost.toFixed(2)} ${opportunity.tokenInSymbol} (${opportunity.gasPriceGwei.toFixed(4)} gwei)

💎 Lucro:
   • Lucro LÍQUIDO: ${opportunity.profit.toFixed(2)} ${opportunity.tokenInSymbol}
   • ROI: ${opportunity.profitPercentage.toFixed(3)}%
   • Volatilidade: ${opportunity.volatility.toFixed(2)}%

🏊 Liquidez:
   • Camelot: $${Math.floor(opportunity.liquidityCamelot).toLocaleString()}
   • Sushiswap: $${Math.floor(opportunity.liquiditySushi).toLocaleString()}

📈 Tendência: ${opportunity.tokenTrend || 'NEUTRAL'}

⏰ Timestamp: ${new Date(opportunity.timestamp).toLocaleString()}
${'═'.repeat(60)}
        `);

        // Executar simulação se configurado
        if (CONFIG.ADVANCED_SIMULATION) {
            this.simulateArbitrage(opportunity);
        }

        // Decidir se executa
        const isMemecoinPair = opportunity.tokenOutSymbol === 'WIF';
        const minLiquidity = isMemecoinPair ? 
            CONFIG.MEMECOIN_PARAMS.MIN_LIQUIDITY_USD : 
            CONFIG.MIN_LIQUIDITY_USD;
            
        const maxGasPrice = CONFIG.MAX_GAS_PRICE_GWEI;
        const minProfitPercentage = isMemecoinPair ? 
            CONFIG.MEMECOIN_PARAMS.MIN_PROFIT_PERCENTAGE : 
            CONFIG.MIN_PROFIT_PERCENTAGE;

        if (CONFIG.AUTO_EXECUTE &&
            opportunity.profitPercentage >= minProfitPercentage &&
            opportunity.liquidityCamelot >= minLiquidity &&
            opportunity.liquiditySushi >= minLiquidity &&
            opportunity.gasPriceGwei <= maxGasPrice &&
            opportunity.volatility <= 5) { // Adicionar verificação de volatilidade

            console.log('🤖 Execução automática ativada...');
            this.executeArbitrage(opportunity);
        } else if (!CONFIG.AUTO_EXECUTE) {
            console.log('ℹ️  Modo monitoramento apenas (AUTO_EXECUTE = false)');
        }
    }

    /**
     * Exibir as estatísticas
     */
    displayStats() {
        const runtime = (Date.now() - this.stats.startTime) / 1000;
        const hours = Math.floor(runtime / 3600);
        const minutes = Math.floor((runtime % 3600) / 60);

        console.log(`
📊 ESTATÍSTICAS
   • Tempo de execução: ${hours}h ${minutes}m
   • Verificações: ${this.stats.checksPerformed}
   • Oportunidades encontradas: ${this.stats.opportunitiesFound}
   • Operações executadas: ${this.stats.tradesExecuted}
   • Lucro total: ${this.stats.totalProfit.toFixed(2)} USDC
        `);
    }

    /**
     * Gerar relatório detalhado de estatísticas
     */
    generateDetailedReport() {
        const runtime = (Date.now() - this.stats.startTime) / 1000;
        const hours = Math.floor(runtime / 3600);
        const minutes = Math.floor((runtime % 3600) / 60);
        
        // Ler o arquivo de log de oportunidades
        let opportunities = [];
        try {
            const logContent = fs.readFileSync('opportunities.log', 'utf8');
            opportunities = logContent.split('\n')
                .filter(line => line.trim() !== '')
                .map(line => JSON.parse(line));
        } catch (error) {
            console.log('⚠️  Nenhum arquivo de oportunidades encontrado');
        }
        
        // Calcular estatísticas adicionais
        let totalOpportunities = opportunities.length;
        let profitableOpportunities = opportunities.filter(opp => opp.profit > 0).length;
        let avgProfit = totalOpportunities > 0 ? 
            opportunities.reduce((sum, opp) => sum + opp.profit, 0) / totalOpportunities : 0;
        let avgROI = totalOpportunities > 0 ? 
            opportunities.reduce((sum, opp) => sum + opp.profitPercentage, 0) / totalOpportunities : 0;
        
        console.log(`
${'═'.repeat(60)}
📈 RELATÓRIO DETALHADO DE ESTATÍSTICAS
${'═'.repeat(60)}
⏱️  Tempo de execução: ${hours}h ${minutes}m
🔍 Verificações realizadas: ${this.stats.checksPerformed}
💎 Oportunidades encontradas: ${this.stats.opportunitiesFound}
✅ Operações executadas: ${this.stats.tradesExecuted}
💰 Lucro total: ${this.stats.totalProfit.toFixed(2)} USDC

📊 Análise de Oportunidades:
   • Total de oportunidades registradas: ${totalOpportunities}
   • Oportunidades lucrativas: ${profitableOpportunities}
   • Lucro médio por oportunidade: ${avgProfit.toFixed(2)} USDC
   • ROI médio: ${avgROI.toFixed(3)}%

📅 Última atualização: ${new Date().toLocaleString()}
${'═'.repeat(60)}
        `);
    }

    /**
     * Testar conectividade com os contratos
     */
    async testConnectivity() {
        console.log('🔍 Testando conectividade com os contratos...\n');
        
        try {
            // Testar conexão com a rede
            const blockNumber = await this.provider.getBlockNumber();
            console.log(`✅ Conectado à rede (Bloco: ${blockNumber})`);
            
            // Testar conexão com os roteadores DEX
            const camelotTestAmount = ethers.parseUnits("1", 18); // 1 WETH
            const camelotPath = [CONFIG.TOKENS.WETH, CONFIG.TOKENS.USDC];
            const camelotAmounts = await this.camelotRouter.getAmountsOut(camelotTestAmount, camelotPath);
            console.log(`✅ Camelot Router conectado (1 WETH = ${ethers.formatUnits(camelotAmounts[1], 6)} USDC)`);
            
            const sushiTestAmount = ethers.parseUnits("1", 18); // 1 WETH
            const sushiPath = [CONFIG.TOKENS.WETH, CONFIG.TOKENS.USDC];
            const sushiAmounts = await this.sushiswapRouter.getAmountsOut(sushiTestAmount, sushiPath);
            console.log(`✅ Sushiswap Router conectado (1 WETH = ${ethers.formatUnits(sushiAmounts[1], 6)} USDC)`);
            
            // Testar conexão com as fábricas
            const camelotPair = await this.camelotFactory.getPair(CONFIG.TOKENS.USDC, CONFIG.TOKENS.WETH);
            console.log(`✅ Camelot Factory conectada (Par USDC/WETH: ${camelotPair})`);
            
            const sushiPair = await this.sushiFactory.getPair(CONFIG.TOKENS.USDC, CONFIG.TOKENS.WETH);
            console.log(`✅ Sushiswap Factory conectada (Par USDC/WETH: ${sushiPair})`);
            
            // Testar contrato FlashLoan se configurado
            if (this.flashLoanContract) {
                const owner = await this.flashLoanContract.owner();
                console.log(`✅ Contrato FlashLoan conectado (Owner: ${owner})`);
                
                // Testar função getBalance
                try {
                    const balance = await this.flashLoanContract.getBalance(CONFIG.TOKENS.USDC);
                    console.log(`✅ Função getBalance funcionando (${ethers.formatUnits(balance, 6)} USDC)`);
                } catch (error) {
                    console.log('⚠️  Função getBalance não disponível ou sem saldo');
                }
            } else {
                console.log('ℹ️  Contrato FlashLoan não configurado');
            }
            
            console.log('\n✅ Todos os testes de conectividade passaram!\n');
            return true;
        } catch (error) {
            console.error('❌ Erro nos testes de conectividade:', error.message);
            return false;
        }
    }

    /**
     * Verificar única (modo --check)
     */
    async checkOnce() {
        console.log('🔍 Verificação única de oportunidades...\n');

        const opportunities = await this.checkOpportunities();

        if (opportunities.length > 0) {
            opportunities.forEach(opp => this.displayOpportunity(opp));
        } else {
            console.log('❌ Nenhuma oportunidade lucrativa encontrada no momento');
            console.log(`   (Lucro mínimo requerido: ${CONFIG.MIN_PROFIT_PERCENTAGE}%)\n`);
        }
        
        // Gerar relatório detalhado
        this.generateDetailedReport();
    }

    /**
     * Iniciar o monitoramento contínuo
     */
    async start() {
        console.log(`
${'═'.repeat(60)}
🤖 INICIANDO O BOT DE ARBITRAGEM
${'═'.repeat(60)}
⚙️  Configuração:
   • RPC: ${CONFIG.RPC_URL.substring(0, 40)}...
   • Contrato Flash Loan: ${CONFIG.FLASHLOAN_CONTRACT_ADDRESS || 'Não configurado'}
   • Valores testados: ${CONFIG.FLASH_LOAN_AMOUNTS.join(', ')} USDC
   • Lucro mínimo: ${CONFIG.MIN_PROFIT_PERCENTAGE}%
   • Perda máxima permitida: ${CONFIG.MAX_LOSS_PERCENTAGE}%
   • Intervalo: ${CONFIG.CHECK_INTERVAL / 1000}s
   • Auto-execução: ${CONFIG.AUTO_EXECUTE ? '✅ SIM' : '❌ NÃO'}
   • Modo: ${CONFIG.DRY_RUN ? '🧪 DRY RUN' : '🔴 AO VIVO'}
   • Gas máximo: ${CONFIG.MAX_GAS_PRICE_GWEI} gwei
${'═'.repeat(60)}
        `);

        // Testar conectividade
        console.log('🔍 Testando conectividade...\n');
        const connectivityOk = await this.testConnectivity();
        if (!connectivityOk) {
            console.log('❌ Falha nos testes de conectividade. Encerrando...');
            return;
        }

        // Loop de monitoramento
        console.log('🔄 Iniciando o monitoramento...\n');

        let iterationCount = 0;
        setInterval(async () => {
            try {
                iterationCount++;

                const opportunities = await this.checkOpportunities();

                if (opportunities.length > 0) {
                    opportunities.forEach(opp => this.displayOpportunity(opp));
                } else {
                    // Log silencioso a cada 10 iterações
                    if (iterationCount % 10 === 0) {
                        console.log(`[${new Date().toLocaleTimeString()}] Nenhuma oportunidade (Verificação #${this.stats.checksPerformed})`);
                    }
                }

                // Exibir as estatísticas a cada 100 verificações
                if (iterationCount % 100 === 0) {
                    this.displayStats();
                }

                // Gerar relatório detalhado a cada 1000 verificações
                if (iterationCount % 1000 === 0) {
                    this.generateDetailedReport();
                }

            } catch (error) {
                console.error('❌ Erro no loop de monitoramento:', error.message);
            }
        }, CONFIG.CHECK_INTERVAL);
    }
}

// Cache com expiração para dados voláteis
class SmartCache {
    constructor() {
        this.cache = new Map();
        this.expirations = new Map();
    }
    
    set(key, value, ttl = 30000) { // 30 segundos por padrão
        this.cache.set(key, value);
        this.expirations.set(key, Date.now() + ttl);
    }
    
    get(key) {
        if (!this.cache.has(key)) return null;
        
        if (Date.now() > this.expirations.get(key)) {
            // Expirado
            this.cache.delete(key);
            this.expirations.delete(key);
            return null;
        }
        
        return this.cache.get(key);
    }
    
    clear() {
        this.cache.clear();
        this.expirations.clear();
    }
}

// ═══════════════════════════════════════════════════════
// PONTO DE ENTRADA
// ═══════════════════════════════════════════════════════

if (require.main === module) {
    const args = process.argv.slice(2);
    const bot = new ArbitrageBot();

    if (args.includes('--check')) {
        // Modo verificação única
        bot.checkOnce();
    } else {
        // Modo monitoramento contínuo
        bot.start();
    }
}

module.exports = { ArbitrageBot };