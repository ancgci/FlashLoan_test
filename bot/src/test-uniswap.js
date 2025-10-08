// test-uniswap.js - Script para testar especificamente a conectividade com Uniswap V3
require('dotenv').config();
const { ethers } = require('ethers');

// Configuração
const RPC_URL = process.env.RPC_URL || process.env.ARBITRUM_RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Endereços dos contratos
const UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"; // Quoter contract

// ABIs
const UNISWAP_V3_ROUTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public view returns (uint256 amountOut)'
];

const UNISWAP_V3_FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];

// ABI para o contrato Quoter (específico para cotações)
const UNISWAP_QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) public view returns (uint256 amountOut)'
];

// Tokens
const TOKENS = {
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
};

async function testUniswapConnectivity() {
    console.log('🔍 Testando conectividade com Uniswap V3...\n');
    
    try {
        const uniswapRouter = new ethers.Contract(UNISWAP_ROUTER, UNISWAP_V3_ROUTER_ABI, provider);
        const uniswapFactory = new ethers.Contract(UNISWAP_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);
        const uniswapQuoter = new ethers.Contract(UNISWAP_QUOTER, UNISWAP_QUOTER_ABI, provider);
        
        const blockNumber = await provider.getBlockNumber();
        console.log(`✅ Conectado à rede (Bloco: ${blockNumber})`);
        
        // Testar factory
        const fees = [500, 3000, 10000];
        for (const fee of fees) {
            try {
                const poolAddress = await uniswapFactory.getPool(TOKENS.WETH, TOKENS.USDC, fee);
                console.log(`✅ Factory (taxa ${fee/10000}%): Pool = ${poolAddress}`);
            } catch (error) {
                console.log(`❌ Factory (taxa ${fee/10000}%): ${error.message}`);
            }
        }
        
        console.log('');
        
        // Testar quoter (método recomendado para cotações)
        for (const fee of fees) {
            try {
                const amountOut = await uniswapQuoter.quoteExactInputSingle(
                    TOKENS.WETH,
                    TOKENS.USDC,
                    fee,
                    ethers.parseUnits("1", 18),
                    0
                );
                console.log(`✅ Quoter (taxa ${fee/10000}%): 1 WETH = ${ethers.formatUnits(amountOut, 6)} USDC`);
            } catch (error) {
                console.log(`❌ Quoter (taxa ${fee/10000}%): ${error.message.substring(0, 100)}...`);
            }
        }
        
        console.log('');
        
        // Testar router (método que pode reverter)
        for (const fee of fees) {
            try {
                const amountOut = await uniswapRouter.quoteExactInputSingle(
                    TOKENS.WETH,
                    TOKENS.USDC,
                    fee,
                    ethers.parseUnits("1", 18),
                    0
                );
                console.log(`✅ Router (taxa ${fee/10000}%): 1 WETH = ${ethers.formatUnits(amountOut, 6)} USDC`);
            } catch (error) {
                console.log(`❌ Router (taxa ${fee/10000}%): ${error.message.substring(0, 100)}...`);
            }
        }
        
        console.log('\n✅ Teste concluído!\n');
    } catch (error) {
        console.error('❌ Erro:', error.message);
    }
}

testUniswapConnectivity().catch(console.error);