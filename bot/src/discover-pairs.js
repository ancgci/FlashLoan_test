// discover-pairs.js - Script para descobrir automaticamente pares disponíveis
require('dotenv').config();
const { ethers } = require('ethers');

// Configuração
const RPC_URL = process.env.RPC_URL || process.env.ARBITRUM_RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Endereços dos contratos
const CAMELOT_FACTORY = "0x6EcCab422D763aC031210895C81787E87B43A652";
const SUSHI_FACTORY = "0xc35DADB65012eC5796536bD9864eD8773aBc74C4";
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory

// ABIs
const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) view returns (address pair)"
];

// ABI para Uniswap V3 Pool
const UNISWAP_V3_FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

// Tokens populares na Arbitrum (incluindo memecoins)
const TOKENS = {
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WIF: '0x12b535631ae4431c909e775e610e7391e16a09e7', // Dogwifhat
    PEPE: '0x25d887Ce7a35172C62Eb276F767BC7624C9505a6', // Pepe
    SHIB: '0x8f6F63e05408D3e38F2E3768DD41582707803F1D', // Shiba Inu
    FLOKI: '0x9f6175901d5700467D017732Be484592315894E4', // Floki Inu
    BONK: '0x1FD11856871b33050c7806f0e354C31B15519416', // Bonk
};

async function checkPair(factoryAddress, tokenA, tokenB, dexName) {
    try {
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(tokenA, tokenB);
        
        if (pairAddress === ethers.ZeroAddress) {
            return { exists: false, address: null, dex: dexName };
        }
        
        return { exists: true, address: pairAddress, dex: dexName };
    } catch (error) {
        return { exists: false, address: null, dex: dexName, error: error.message };
    }
}

async function checkUniswapV3Pool(factoryAddress, tokenA, tokenB, dexName) {
    try {
        const factory = new ethers.Contract(factoryAddress, UNISWAP_V3_FACTORY_ABI, provider);
        // Verificar diferentes níveis de taxa
        const fees = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
        for (const fee of fees) {
            try {
                const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                if (poolAddress !== ethers.ZeroAddress) {
                    return { exists: true, address: poolAddress, dex: dexName, fee: fee };
                }
            } catch (e) {
                // Continuar tentando outras taxas
            }
        }
        return { exists: false, address: null, dex: dexName };
    } catch (error) {
        return { exists: false, address: null, dex: dexName, error: error.message };
    }
}

async function discoverPairs() {
    console.log('🔍 Descobrindo pares disponíveis...\n');
    
    // Combinar todos os tokens
    const tokenSymbols = Object.keys(TOKENS);
    const pairsToCheck = [];
    
    // Gerar todas as combinações de pares
    for (let i = 0; i < tokenSymbols.length; i++) {
        for (let j = i + 1; j < tokenSymbols.length; j++) {
            pairsToCheck.push({
                tokenA: tokenSymbols[i],
                tokenB: tokenSymbols[j],
                addressA: TOKENS[tokenSymbols[i]],
                addressB: TOKENS[tokenSymbols[j]]
            });
        }
    }
    
    // Verificar cada par em todas as DEXs
    const availablePairs = [];
    
    for (const pair of pairsToCheck) {
        console.log(`Verificando par: ${pair.tokenA}/${pair.tokenB}`);
        
        // Verificar no Camelot
        const camelotResult = await checkPair(
            CAMELOT_FACTORY, 
            pair.addressA, 
            pair.addressB, 
            'Camelot'
        );
        
        // Verificar no Sushi
        const sushiResult = await checkPair(
            SUSHI_FACTORY, 
            pair.addressA, 
            pair.addressB, 
            'Sushi'
        );
        
        // Verificar no Uniswap V3
        const uniswapResult = await checkUniswapV3Pool(
            UNISWAP_FACTORY, 
            pair.addressA, 
            pair.addressB, 
            'Uniswap'
        );
        
        // Registrar resultados
        if (camelotResult.exists || sushiResult.exists || uniswapResult.exists) {
            const pairInfo = {
                tokenA: pair.tokenA,
                tokenB: pair.tokenB,
                camelot: camelotResult.exists ? camelotResult.address : null,
                sushi: sushiResult.exists ? sushiResult.address : null,
                uniswap: uniswapResult.exists ? uniswapResult.address : null,
                uniswapFee: uniswapResult.exists ? uniswapResult.fee : null
            };
            
            availablePairs.push(pairInfo);
            
            console.log(`  ✅ ${pair.tokenA}/${pair.tokenB}:`);
            if (camelotResult.exists) {
                console.log(`     Camelot: ${camelotResult.address}`);
            }
            if (sushiResult.exists) {
                console.log(`     Sushi: ${sushiResult.address}`);
            }
            if (uniswapResult.exists) {
                console.log(`     Uniswap: ${uniswapResult.address} (taxa: ${uniswapResult.fee/10000}%)`);
            }
        } else {
            console.log(`  ❌ ${pair.tokenA}/${pair.tokenB}: Não encontrado em nenhuma DEX`);
        }
        
        console.log('');
    }
    
    // Resumo
    console.log('📋 RESUMO DE PARES DISPONÍVEIS:');
    console.log('════════════════════════════════════════════════════════════');
    
    if (availablePairs.length === 0) {
        console.log('Nenhum par encontrado.');
        return;
    }
    
    for (const pair of availablePairs) {
        console.log(`${pair.tokenA}/${pair.tokenB}:`);
        if (pair.camelot) {
            console.log(`  • Camelot: ${pair.camelot}`);
        }
        if (pair.sushi) {
            console.log(`  • Sushi: ${pair.sushi}`);
        }
        if (pair.uniswap) {
            console.log(`  • Uniswap: ${pair.uniswap} (taxa: ${pair.uniswapFee/10000}%)`);
        }
        console.log('');
    }
    
    // Gerar configuração sugerida
    console.log('🔧 CONFIGURAÇÃO SUGERIDA PARA O BOT:');
    console.log('════════════════════════════════════════════════════════════');
    
    console.log('TRADING_PAIRS: [');
    for (const pair of availablePairs) {
        // Par para arbitragem entre DEXs (se existir em múltiplas)
        if (pair.camelot && pair.sushi) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'camelot', dexOut: 'sushi' },`);
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'sushi', dexOut: 'camelot' },`);
        }
        if (pair.camelot && pair.uniswap) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'camelot', dexOut: 'uniswap' },`);
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'uniswap', dexOut: 'camelot' },`);
        }
        if (pair.sushi && pair.uniswap) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'sushi', dexOut: 'uniswap' },`);
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'uniswap', dexOut: 'sushi' },`);
        }
        // Par para arbitragem dentro da mesma DEX (se existir apenas em uma)
        if (pair.camelot && !pair.sushi && !pair.uniswap) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'camelot', dexOut: 'camelot' },`);
        }
        if (pair.sushi && !pair.camelot && !pair.uniswap) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'sushi', dexOut: 'sushi' },`);
        }
        if (pair.uniswap && !pair.camelot && !pair.sushi) {
            console.log(`  { tokenIn: '${pair.tokenA}', tokenOut: '${pair.tokenB}', dexIn: 'uniswap', dexOut: 'uniswap' },`);
        }
    }
    console.log(']');
    
    // Mostrar tokens disponíveis
    console.log('\n🏷️  TOKENS DISPONÍVEIS:');
    console.log('════════════════════════════════════════════════════════════');
    for (const [symbol, address] of Object.entries(TOKENS)) {
        console.log(`${symbol}: ${address}`);
    }
}

discoverPairs().catch(console.error);