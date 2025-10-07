// arbitrage-bot.js - Bot complet de monitoring et exécution d'arbitrage
require('dotenv').config();
const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const CONFIG = {
    // RPC et Wallet
    RPC_URL: process.env.RPC_URL || process.env.ARBITRUM_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    FLASHLOAN_CONTRACT_ADDRESS: process.env.FLASHLOAN_CONTRACT_ADDRESS,

    // Tokens
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',

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

    // Paramètres de trading
    FLASH_LOAN_AMOUNTS: [1000, 5000, 10000], // Montants en USDC à tester
    MIN_PROFIT_PERCENTAGE: 0.5, // 0.5% minimum
    MIN_LIQUIDITY_USD: 50000, // Liquidité minimum par DEX
    CHECK_INTERVAL: 10000, // Vérifier toutes les 10 secondes

    // Exécution
    AUTO_EXECUTE: false, // true = exécute automatiquement, false = log seulement
    MAX_GAS_PRICE_GWEI: 0.5, // Prix max du gas sur Arbitrum
    DRY_RUN: true, // true = simulation seulement
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

        // FlashLoan contract (si disponible)
        if (CONFIG.FLASHLOAN_CONTRACT_ADDRESS && this.wallet) {
            this.flashLoanContract = new ethers.Contract(
                CONFIG.FLASHLOAN_CONTRACT_ADDRESS,
                FLASHLOAN_ABI,
                this.wallet
            );
        }
    }

    // ═══════════════════════════════════════════════════════
    // PRIX ET LIQUIDITÉ
    // ═══════════════════════════════════════════════════════

    /**
     * Obtenir le prix via router (méthode simple)
     */
    async getPriceViaRouter(router, tokenIn, tokenOut, amountIn) {
        try {
            const path = [tokenIn, tokenOut];
            const amounts = await router.getAmountsOut(amountIn, path);
            return amounts[1];
        } catch (error) {
            console.error(`Erreur getPriceViaRouter:`, error.message);
            return null;
        }
    }

    /**
     * Obtenir le prix via pool directement (plus précis, prend en compte les frais)
     */
    async getPriceViaPool(poolAddress, amountIn, tokenIn, tokenOut) {
        try {
            const amountInBN = ethers.getBigInt(amountIn.toString());
            const pool = new ethers.Contract(poolAddress, POOL_ABI, this.provider);

            const [reserve0, reserve1] = await pool.getReserves();
            const token0 = await pool.token0();

            // Déterminer l'ordre des réserves
            const [reserveIn, reserveOut] = token0.toLowerCase() === tokenIn.toLowerCase()
                ? [reserve0, reserve1]
                : [reserve1, reserve0];

            // Formule Uniswap V2 avec frais de 0.3%
            const amountInWithFee = (amountInBN * BigInt(997));
            const numerator = amountInWithFee * reserveOut;
            const denominator = (reserveIn * BigInt(1000)) + amountInWithFee;

            const amountOut = numerator / denominator;
            return amountOut;
        } catch (error) {
            console.error('Erreur getPriceViaPool:', error.message);
            return null;
        }
    }

    /**
     * Vérifier la liquidité d'un pool
     */
    async checkLiquidity(factory, tokenA, tokenB) {
        try {
            const pairAddress = await factory.getPair(tokenA, tokenB);

            if (pairAddress === ethers.ZeroAddress) {
                return 0;
            }

            const pair = new ethers.Contract(pairAddress, POOL_ABI, this.provider);
            const [reserve0, reserve1] = await pair.getReserves();

            // Estimation simple: réserve ETH * 2 * prix ETH estimé
            const ethReserve = Math.max(
                Number(ethers.formatUnits(reserve0, 18)),
                Number(ethers.formatUnits(reserve1, 18))
            );

            // Prix ETH approximatif pour calcul liquidité
            return ethReserve * 2 * 3000; // $3000 per ETH approximatif
        } catch (error) {
            console.error('Erreur checkLiquidity:', error.message);
            return 0;
        }
    }

    /**
     * Obtenir le prix actuel du gas
     */
    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return Number(ethers.formatUnits(feeData.gasPrice, 'gwei'));
        } catch (error) {
            console.error('Erreur getGasPrice:', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════
    // ANALYSE D'OPPORTUNITÉS
    // ═══════════════════════════════════════════════════════

    /**
     * Estimer le profit pour un montant donné
     */
    async estimateProfit(amountInUSDC) {
        try {
            const amountIn = ethers.parseUnits(amountInUSDC.toString(), 6);

            // 1. Prix USDC -> WETH sur Camelot
            const camelotWETHAmount = await this.getPriceViaRouter(
                this.camelotRouter,
                CONFIG.USDC,
                CONFIG.WETH,
                amountIn
            );

            if (!camelotWETHAmount || camelotWETHAmount === 0n) return null;

            // 2. Prix WETH -> USDC sur Sushiswap
            const sushiUSDCAmount = await this.getPriceViaRouter(
                this.sushiswapRouter,
                CONFIG.WETH,
                CONFIG.USDC,
                camelotWETHAmount
            );

            if (!sushiUSDCAmount || sushiUSDCAmount === 0n) return null;

            // 3. Calculer les coûts
            const gasPrice = await this.provider.getFeeData();
            const estimatedGas = 500000n; // Gas estimé
            const gasCostWei = gasPrice.gasPrice * estimatedGas;

            // Prix ETH pour calcul gas en USDC
            const oneEth = ethers.parseUnits("1", 18);
            const ethPriceUSDC = await this.getPriceViaRouter(
                this.camelotRouter,
                CONFIG.WETH,
                CONFIG.USDC,
                oneEth
            );

            const gasCostUSDC = (gasCostWei * ethPriceUSDC) / oneEth;

            // Flash loan fee AAVE = 0.09%
            const flashLoanFee = (amountIn * 9n) / 10000n;

            // 4. Profit net
            const profitUSDC = sushiUSDCAmount - amountIn - gasCostUSDC - flashLoanFee;

            // Vérifier la liquidité
            const liquidityCamelot = await this.checkLiquidity(
                this.camelotFactory,
                CONFIG.USDC,
                CONFIG.WETH
            );

            const liquiditySushi = await this.checkLiquidity(
                this.sushiFactory,
                CONFIG.USDC,
                CONFIG.WETH
            );

            return {
                amountIn: Number(ethers.formatUnits(amountIn, 6)),
                camelotWETHAmount: Number(ethers.formatEther(camelotWETHAmount)),
                sushiUSDCAmount: Number(ethers.formatUnits(sushiUSDCAmount, 6)),
                gasCost: Number(ethers.formatUnits(gasCostUSDC, 6)),
                flashLoanFee: Number(ethers.formatUnits(flashLoanFee, 6)),
                profit: Number(ethers.formatUnits(profitUSDC, 6)),
                profitPercentage: (Number(profitUSDC) / Number(amountIn)) * 100,
                liquidityCamelot,
                liquiditySushi,
                gasPriceGwei: Number(ethers.formatUnits(gasPrice.gasPrice, 'gwei')),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('Erreur estimateProfit:', error.message);
            return null;
        }
    }

    /**
     * Vérifier toutes les opportunités pour différents montants
     */
    async checkOpportunities() {
        this.stats.checksPerformed++;
        const opportunities = [];

        for (const amount of CONFIG.FLASH_LOAN_AMOUNTS) {
            const result = await this.estimateProfit(amount);

            if (result && result.profit > 0) {
                opportunities.push(result);
            }
        }

        return opportunities;
    }

    // ═══════════════════════════════════════════════════════
    // EXÉCUTION
    // ═══════════════════════════════════════════════════════

    /**
     * Exécuter l'arbitrage via le smart contract
     */
    async executeArbitrage(opportunity) {
        if (!this.flashLoanContract) {
            console.log('❌ FlashLoan contract non configuré');
            return false;
        }

        if (CONFIG.DRY_RUN) {
            console.log('🧪 DRY RUN - Transaction non envoyée');
            return false;
        }

        try {
            console.log('\n🚀 EXÉCUTION DE L\'ARBITRAGE...');

            const amountUSDC = ethers.parseUnits(opportunity.amountIn.toString(), 6);

            // Vérifier le owner
            const owner = await this.flashLoanContract.owner();
            if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
                console.log(`❌ Vous n'êtes pas le owner du contrat`);
                console.log(`   Owner: ${owner}`);
                console.log(`   Your address: ${this.wallet.address}`);
                return false;
            }

            // Estimer le gas
            let gasLimit;
            try {
                gasLimit = await this.flashLoanContract.requestFlashLoan.estimateGas(
                    CONFIG.USDC,
                    amountUSDC
                );
                gasLimit = (gasLimit * 120n) / 100n; // +20% de marge
            } catch (error) {
                console.log('⚠️ Impossible d\'estimer le gas, utilisation de la limite par défaut');
                gasLimit = 1000000n;
            }

            // Envoyer la transaction
            console.log('📤 Envoi de la transaction...');
            const tx = await this.flashLoanContract.requestFlashLoan(
                CONFIG.USDC,
                amountUSDC,
                {
                    gasLimit: gasLimit
                }
            );

            console.log(`📝 Tx Hash: ${tx.hash}`);
            console.log('⏳ Attente de confirmation...');

            const receipt = await tx.wait();

            if (receipt.status === 1) {
                console.log('✅ Transaction réussie!');

                // Vérifier le profit réel
                const balanceAfter = await this.flashLoanContract.getBalance(CONFIG.USDC);
                console.log(`💰 Balance après: ${ethers.formatUnits(balanceAfter, 6)} USDC`);

                this.stats.tradesExecuted++;
                this.stats.totalProfit += opportunity.profit;

                this.logTrade(opportunity, tx.hash, true);
                return true;
            } else {
                console.log('❌ Transaction échouée');
                this.logTrade(opportunity, tx.hash, false);
                return false;
            }

        } catch (error) {
            console.error('❌ Erreur lors de l\'exécution:', error.message);

            if (error.message.includes('Arbitrage not profitable')) {
                console.log('⚠️ Le contrat a déterminé que l\'arbitrage n\'était pas profitable');
            }

            return false;
        }
    }

    /**
     * Logger les trades dans un fichier
     */
    logTrade(opportunity, txHash, success) {
        const fs = require('fs');
        const logEntry = {
            timestamp: new Date().toISOString(),
            amount: opportunity.amountIn,
            expectedProfit: opportunity.profit,
            profitPercentage: opportunity.profitPercentage,
            txHash,
            success,
            gasCost: opportunity.gasCost,
            flashLoanFee: opportunity.flashLoanFee
        };

        fs.appendFileSync(
            'trades.log',
            JSON.stringify(logEntry) + '\n'
        );
    }

    // ═══════════════════════════════════════════════════════
    // MONITORING ET AFFICHAGE
    // ═══════════════════════════════════════════════════════

    /**
     * Afficher une opportunité trouvée
     */
    displayOpportunity(opportunity) {
        this.stats.opportunitiesFound++;

        console.log(`
${'═'.repeat(60)}
💰 OPPORTUNITÉ D'ARBITRAGE DÉTECTÉE!
${'═'.repeat(60)}
📊 Montants:
   • Flash Loan: ${opportunity.amountIn.toFixed(2)} USDC
   • WETH reçu (Camelot): ${opportunity.camelotWETHAmount.toFixed(6)} WETH
   • USDC final (Sushiswap): ${opportunity.sushiUSDCAmount.toFixed(2)} USDC

💵 Coûts:
   • Flash Loan Fee (0.09%): ${opportunity.flashLoanFee.toFixed(2)} USDC
   • Gas estimé: ${opportunity.gasCost.toFixed(2)} USDC (${opportunity.gasPriceGwei.toFixed(4)} gwei)

💎 Profit:
   • Profit NET: ${opportunity.profit.toFixed(2)} USDC
   • ROI: ${opportunity.profitPercentage.toFixed(3)}%

🏊 Liquidité:
   • Camelot: $${Math.floor(opportunity.liquidityCamelot).toLocaleString()}
   • Sushiswap: $${Math.floor(opportunity.liquiditySushi).toLocaleString()}

⏰ Timestamp: ${new Date(opportunity.timestamp).toLocaleString()}
${'═'.repeat(60)}
        `);

        // Décider si on exécute
        if (CONFIG.AUTO_EXECUTE &&
            opportunity.profitPercentage >= CONFIG.MIN_PROFIT_PERCENTAGE &&
            opportunity.liquidityCamelot >= CONFIG.MIN_LIQUIDITY_USD &&
            opportunity.liquiditySushi >= CONFIG.MIN_LIQUIDITY_USD &&
            opportunity.gasPriceGwei <= CONFIG.MAX_GAS_PRICE_GWEI) {

            console.log('🤖 Exécution automatique activée...');
            this.executeArbitrage(opportunity);
        } else if (!CONFIG.AUTO_EXECUTE) {
            console.log('ℹ️  Mode monitoring seulement (AUTO_EXECUTE = false)');
        }
    }

    /**
     * Afficher les statistiques
     */
    displayStats() {
        const runtime = (Date.now() - this.stats.startTime) / 1000;
        const hours = Math.floor(runtime / 3600);
        const minutes = Math.floor((runtime % 3600) / 60);

        console.log(`
📊 STATISTIQUES
   • Runtime: ${hours}h ${minutes}m
   • Vérifications: ${this.stats.checksPerformed}
   • Opportunités trouvées: ${this.stats.opportunitiesFound}
   • Trades exécutés: ${this.stats.tradesExecuted}
   • Profit total: ${this.stats.totalProfit.toFixed(2)} USDC
        `);
    }

    // ═══════════════════════════════════════════════════════
    // DÉMARRAGE
    // ═══════════════════════════════════════════════════════

    /**
     * Vérification unique (mode --check)
     */
    async checkOnce() {
        console.log('🔍 Vérification unique des opportunités...\n');

        const opportunities = await this.checkOpportunities();

        if (opportunities.length > 0) {
            opportunities.forEach(opp => this.displayOpportunity(opp));
        } else {
            console.log('❌ Aucune opportunité profitable trouvée pour le moment');
            console.log(`   (Profit minimum requis: ${CONFIG.MIN_PROFIT_PERCENTAGE}%)\n`);
        }
    }

    /**
     * Démarrer le monitoring continu
     */
    async start() {
        console.log(`
${'═'.repeat(60)}
🤖 DÉMARRAGE DU BOT D'ARBITRAGE
${'═'.repeat(60)}
⚙️  Configuration:
   • RPC: ${CONFIG.RPC_URL.substring(0, 40)}...
   • Flash Loan Contract: ${CONFIG.FLASHLOAN_CONTRACT_ADDRESS || 'Non configuré'}
   • Montants testés: ${CONFIG.FLASH_LOAN_AMOUNTS.join(', ')} USDC
   • Profit minimum: ${CONFIG.MIN_PROFIT_PERCENTAGE}%
   • Intervalle: ${CONFIG.CHECK_INTERVAL / 1000}s
   • Auto-exécution: ${CONFIG.AUTO_EXECUTE ? '✅ OUI' : '❌ NON'}
   • Mode: ${CONFIG.DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE'}
   • Gas max: ${CONFIG.MAX_GAS_PRICE_GWEI} gwei
${'═'.repeat(60)}
        `);

        // Vérifier la connexion
        try {
            const blockNumber = await this.provider.getBlockNumber();
            console.log(`✅ Connecté au réseau (Block: ${blockNumber})\n`);
        } catch (error) {
            console.error('❌ Impossible de se connecter au RPC:', error.message);
            return;
        }

        // Vérifier le contrat si configuré
        if (this.flashLoanContract) {
            try {
                const owner = await this.flashLoanContract.owner();
                console.log(`✅ FlashLoan contract connecté (Owner: ${owner})\n`);
            } catch (error) {
                console.error('❌ Impossible de se connecter au contrat:', error.message);
            }
        } else {
            console.log('⚠️  FlashLoan contract non configuré - Mode monitoring seulement\n');
        }

        // Boucle de monitoring
        console.log('🔄 Démarrage du monitoring...\n');

        let iterationCount = 0;
        setInterval(async () => {
            try {
                iterationCount++;

                const opportunities = await this.checkOpportunities();

                if (opportunities.length > 0) {
                    opportunities.forEach(opp => this.displayOpportunity(opp));
                } else {
                    // Log silencieux toutes les 10 itérations
                    if (iterationCount % 10 === 0) {
                        console.log(`[${new Date().toLocaleTimeString()}] Pas d'opportunité (Check #${this.stats.checksPerformed})`);
                    }
                }

                // Afficher les stats toutes les 100 vérifications
                if (iterationCount % 100 === 0) {
                    this.displayStats();
                }

            } catch (error) {
                console.error('❌ Erreur dans la boucle de monitoring:', error.message);
            }
        }, CONFIG.CHECK_INTERVAL);
    }
}

// ═══════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ═══════════════════════════════════════════════════════

if (require.main === module) {
    const args = process.argv.slice(2);
    const bot = new ArbitrageBot();

    if (args.includes('--check')) {
        // Mode vérification unique
        bot.checkOnce();
    } else {
        // Mode monitoring continu
        bot.start();
    }
}

module.exports = { ArbitrageBot };
