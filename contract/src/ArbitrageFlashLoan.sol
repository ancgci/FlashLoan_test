// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {FlashLoanSimpleReceiverBase} from "../lib/aave-v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "../lib/aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "../node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CamelotRouter} from "../lib/periphery/contracts/CamelotRouter.sol";
import {IUniswapV2Router02} from "../lib/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";


// get USDC from AAVE
// swap USDC for WETH on Camelot
// swap WETH for USDC on Sushiswap
// repay the loan

contract ArbitrageFlashLoan is FlashLoanSimpleReceiverBase {

    // ------------------------Variables-------------------------------------

    address payable public  owner;
    address payable sushiswapRouterAddress;
    address payable camelotRouterAddress;
    address inTokenAddress;
    address outTokenAddress;

    // ------------------------Events-------------------------------------
    event SwapExecuted(string platform, uint256 amountIn, uint256 amountOut);
    event FlashLoanInitiated(address token, uint256 amount);
    event Debug(string message, uint256 value);

    // ------------------------Constant -------------------------------------
    uint256 private constant SLIPPAGE_TOLERANCE = 99; // 1% slippage tolerance
    uint256 private constant DEADLINE_EXTENSION = 120; // 2 minutes

    // ------------------------Constructor-------------------------------------

    constructor(
        address _addressProviderAave,
        address payable _sushiswapRouterAddress,
        address payable  _camelotRouterAddress
    ) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProviderAave))
    {
        require(_sushiswapRouterAddress != address(0), "Invalid Sushiswap router");
        require(_camelotRouterAddress != address(0), "Invalid Camelot router");
        sushiswapRouterAddress = _sushiswapRouterAddress;
        camelotRouterAddress = _camelotRouterAddress;
        owner = payable(msg.sender);
    }

    function requestFlashLoan(address _tokenForLoan, uint256 _amount) external onlyOwner {
        emit FlashLoanInitiated(_tokenForLoan, _amount);

        POOL.flashLoanSimple(
            address(this),
            _tokenForLoan,
            _amount,
            "",
            0
        );
    }

    function swapTokenOnCamelot(
        address _tokenIn,
        address _tokenOut,
        uint256 _amount
    ) private returns (uint256){
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;

        IERC20(_tokenIn).approve(camelotRouterAddress, _amount);

        uint256 amountOutMin = CamelotRouter(camelotRouterAddress).
            getAmountsOut(_amount, path)[1] * SLIPPAGE_TOLERANCE / 100;

        CamelotRouter(camelotRouterAddress).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            _amount,
            amountOutMin,
            path,
            address(this),
            address(0),
            block.timestamp + DEADLINE_EXTENSION
        );

        uint256 balanceAfter = IERC20(_tokenOut).balanceOf(address(this));
        emit SwapExecuted("Camelot", _amount, balanceAfter);
        return balanceAfter;
    }

    function exchangeTokenOnSushiswap(
        address _tokenIn,
        address _tokenOut,
        uint256 _amount
    ) private returns (uint256) {
        require(_amount > 0, "Amount must be greater than 0");

        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;

        IERC20(_tokenIn).approve(sushiswapRouterAddress, _amount);

        uint256 amountsOutMin = IUniswapV2Router02(sushiswapRouterAddress).
            getAmountsOut(_amount, path)[1] * SLIPPAGE_TOLERANCE / 100;

        emit Debug("AmountsOutMin", amountsOutMin);


        uint256[] memory amounts = IUniswapV2Router02(sushiswapRouterAddress).swapExactTokensForTokens(
            _amount,
            amountsOutMin,
            path,
            address(this),
            block.timestamp + DEADLINE_EXTENSION
        );

        emit SwapExecuted("Sushiswap", _amount, amounts[1]);
        return amounts[1];
    }

    function setArbitrageDetails(
        address _tokenIn,
        address _tokenOut
    ) public onlyOwner {
        require(msg.sender == owner, "only owner can call the function");
        inTokenAddress = _tokenIn;
        outTokenAddress = _tokenOut;
    }

    function arbitrage(
    address _tokenIn,
    address _tokenOut
    ) internal {
        uint256 initialBalance = IERC20(_tokenIn).balanceOf(address(this));
        require(initialBalance > 0, "No tokens to swap");
        uint256 usdBalanceBefore = IERC20(_tokenIn).balanceOf(address(this));

        uint256 wethBalance = swapTokenOnCamelot(_tokenIn, _tokenOut, initialBalance);
        require(wethBalance > 0, "Camelot swap failed");

        uint256 usdBalanceAfterCamelot = IERC20(_tokenIn).balanceOf(address(this));
        uint256 finalBalance = exchangeTokenOnSushiswap(_tokenOut, _tokenIn, wethBalance);
        emit Debug("USDC Balance Before Camelot Swap (should be the loan: 10k)", usdBalanceBefore);
        emit Debug("USDC Balance After Camelot Swap (should be 0)", usdBalanceAfterCamelot);
        emit Debug("WETH Balance After Camelot Swap (should be equivalent of the loan in WETH)", wethBalance);
        emit Debug("USDC final balance (should be more thant the loan", finalBalance);
        require(finalBalance > initialBalance, "Arbitrage not profitable");
    }

    function executeOperation(
        address _asset,
        uint256 _amount,
        uint256 _premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller is not the pool");
        arbitrage(inTokenAddress, outTokenAddress);
        // Repay the loan:
        uint256 amountOwed = _amount + _premium;
        IERC20(_asset).approve(address(POOL), amountOwed);
        return true;
    }

    function getBalance(address _tokenAddress) external view returns (uint256) {
        return IERC20(_tokenAddress).balanceOf(address(this));
    }

    function withdraw(address _tokenAddress) external onlyOwner {
        IERC20 token = IERC20(_tokenAddress);
        token.transfer(msg.sender, token.balanceOf(address(this)));
    }
    // --------------------Modifier-------------------------------------

    modifier onlyOwner() {
        require(
            msg.sender == owner,
            "Only the contract owner can call this function"
        );
        _;
    }

    receive() external payable {}
}
