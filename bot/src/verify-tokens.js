// verify-tokens.js - Script para verificar endereços de tokens e pools
require('dotenv').config();
const { ethers } = require('ethers');

// Configuração
const RPC_URL = process.env.RPC_URL || process.env.ARBITRUM_RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Endereços dos contratos
const CAMELOT_ROUTER = "0xc873fEcbd354f5A56E00E710B90EF4201db2448d";
const CAMELOT_FACTORY = "0x6EcCab422D763aC031210895C81787E87B43A652";
const SUSHI_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const SUSHI_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";

// ABIs
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) view returns (address pair)"
];

const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)"
];

// Tokens
const TOKENS = {
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WIF: '0x12b535631ae4431c909e775e610e7391e16a09e7', // Dogwifhat
};

async function verifyToken(tokenAddress, symbol) {
    try {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const name = await token.name();
        const symbol = await token.symbol();
        const decimals = await token.decimals();
        
        console.log(`✅ ${symbol} (${name})`);
        console.log(`   Endereço: ${tokenAddress}`);
        console.log(`   Decimais: ${decimals}`);
        return true;
    } catch (error) {
        console.log(`❌ Erro ao verificar ${symbol}: ${error.message}`);
        return false;
    }
}

async function checkPair(factoryAddress, tokenA, tokenB, dexName) {
    try {
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(tokenA, tokenB);
        
        if (pairAddress === ethers.ZeroAddress) {
            console.log(`❌ Par não encontrado em ${dexName}`);
            return false;
        }
        
        console.log(`✅ Par encontrado em ${dexName}: ${pairAddress}`);
        return true;
    } catch (error) {
        console.log(`❌ Erro ao verificar par em ${dexName}: ${error.message}`);
        return false;
    }
}

async function checkLiquidity(routerAddress, tokenIn, tokenOut, amountIn, symbolIn, symbolOut) {
    try {
        const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
        const path = [tokenIn, tokenOut];
        const amounts = await router.getAmountsOut(amountIn, path);
        
        console.log(`✅ Swap possível: ${ethers.formatUnits(amountIn, symbolIn === 'USDC' ? 6 : 18)} ${symbolIn} → ${ethers.formatUnits(amounts[1], symbolOut === 'USDC' ? 6 : 18)} ${symbolOut}`);
        return amounts[1];
    } catch (error) {
        console.log(`❌ Erro no swap ${symbolIn} → ${symbolOut}: ${error.message}`);
        return null;
    }
}

async function main() {
    console.log('🔍 Verificando tokens e pools...\n');
    
    // Verificar tokens
    for (const [symbol, address] of Object.entries(TOKENS)) {
        await verifyToken(address, symbol);
        console.log('');
    }
    
    // Verificar pares
    console.log('🔍 Verificando pares de trading...\n');
    
    // USDC/WETH
    console.log('Par: USDC/WETH');
    await checkPair(CAMELOT_FACTORY, TOKENS.USDC, TOKENS.WETH, 'Camelot');
    await checkPair(SUSHI_FACTORY, TOKENS.USDC, TOKENS.WETH, 'Sushi');
    console.log('');
    
    // USDC/WIF
    console.log('Par: USDC/WIF');
    await checkPair(CAMELOT_FACTORY, TOKENS.USDC, TOKENS.WIF, 'Camelot');
    await checkPair(SUSHI_FACTORY, TOKENS.USDC, TOKENS.WIF, 'Sushi');
    console.log('');
    
    // WETH/WIF
    console.log('Par: WETH/WIF');
    await checkPair(CAMELOT_FACTORY, TOKENS.WETH, TOKENS.WIF, 'Camelot');
    await checkPair(SUSHI_FACTORY, TOKENS.WETH, TOKENS.WIF, 'Sushi');
    console.log('');
    
    // Testar swaps
    console.log('🔍 Testando swaps...\n');
    
    // Testar swap USDC → WETH
    console.log('Swap: USDC → WETH');
    const usdcAmount = ethers.parseUnits("1000", 6);
    await checkLiquidity(CAMELOT_ROUTER, TOKENS.USDC, TOKENS.WETH, usdcAmount, 'USDC', 'WETH');
    await checkLiquidity(SUSHI_ROUTER, TOKENS.USDC, TOKENS.WETH, usdcAmount, 'USDC', 'WETH');
    console.log('');
    
    // Testar swap WETH → USDC
    console.log('Swap: WETH → USDC');
    const wethAmount = ethers.parseUnits("1", 18);
    await checkLiquidity(CAMELOT_ROUTER, TOKENS.WETH, TOKENS.USDC, wethAmount, 'WETH', 'USDC');
    await checkLiquidity(SUSHI_ROUTER, TOKENS.WETH, TOKENS.USDC, wethAmount, 'WETH', 'USDC');
    console.log('');
}

main().catch(console.error);