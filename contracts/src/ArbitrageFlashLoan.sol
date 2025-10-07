// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {FlashLoanSimpleReceiverBase} from "../lib/aave-v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "../lib/aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IERC20} from "../node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "../node_modules/@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "../node_modules/@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CamelotRouter} from "../lib/periphery/contracts/CamelotRouter.sol";
import {IUniswapV2Router02} from "../lib/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";


// get USDC from AAVE
// swap USDC for WETH on Camelot
// swap WETH for USDC on Sushiswap
// repay the loan

contract ArbitrageFlashLoan is FlashLoanSimpleReceiverBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------Variables-------------------------------------

    address payable public immutable owner;
    address payable public immutable sushiswapRouterAddress;
    address payable public immutable camelotRouterAddress;
    address public inTokenAddress;
    address public outTokenAddress;

    // ------------------------Events-------------------------------------
    event SwapExecuted(string platform, uint256 amountIn, uint256 amountOut);
    event FlashLoanInitiated(address token, uint256 amount);
    event ArbitrageCompleted(uint256 profit);
    event Debug(string message, uint256 value);

    // ------------------------Constant -------------------------------------
    uint256 private constant SLIPPAGE_TOLERANCE = 99; // 1% slippage tolerance
    uint256 private constant DEADLINE_EXTENSION = 120; // 2 minutes
    uint256 private constant MAX_APPROVAL = type(uint256).max;

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

    function requestFlashLoan(address _tokenForLoan, uint256 _amount) external onlyOwner nonReentrant {
        require(_tokenForLoan == inTokenAddress, "Token mismatch with arbitrage settings");
        require(_amount > 0, "Amount must be greater than 0");

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
        require(_amount > 0, "Amount must be greater than 0");

        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;

        // Use SafeERC20 for safer approval
        IERC20(_tokenIn).safeIncreaseAllowance(camelotRouterAddress, _amount);

        uint256 amountOutMin = CamelotRouter(camelotRouterAddress).
            getAmountsOut(_amount, path)[1] * SLIPPAGE_TOLERANCE / 100;

        uint256 balanceBefore = IERC20(_tokenOut).balanceOf(address(this));

        CamelotRouter(camelotRouterAddress).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            _amount,
            amountOutMin,
            path,
            address(this),
            address(0),
            block.timestamp + DEADLINE_EXTENSION
        );

        uint256 balanceAfter = IERC20(_tokenOut).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        require(received > 0, "Camelot swap failed");

        emit SwapExecuted("Camelot", _amount, received);
        return received;
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

        // Use SafeERC20 for safer approval
        IERC20(_tokenIn).safeIncreaseAllowance(sushiswapRouterAddress, _amount);

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

        require(amounts[1] > 0, "Sushiswap swap failed");
        emit SwapExecuted("Sushiswap", _amount, amounts[1]);
        return amounts[1];
    }

    function setArbitrageDetails(
        address _tokenIn,
        address _tokenOut
    ) external onlyOwner {
        require(_tokenIn != address(0), "Invalid token address");
        require(_tokenOut != address(0), "Invalid token address");
        require(_tokenIn != _tokenOut, "Tokens must be different");
        inTokenAddress = _tokenIn;
        outTokenAddress = _tokenOut;
    }

    function arbitrage(
        address _tokenIn,
        address _tokenOut,
        uint256 _initialBalance
    ) internal returns (uint256) {
        require(_initialBalance > 0, "No tokens to swap");

        uint256 usdBalanceBefore = IERC20(_tokenIn).balanceOf(address(this));

        // Step 1: Swap tokenIn for tokenOut on Camelot
        uint256 wethBalance = swapTokenOnCamelot(_tokenIn, _tokenOut, _initialBalance);

        uint256 usdBalanceAfterCamelot = IERC20(_tokenIn).balanceOf(address(this));

        // Step 2: Swap tokenOut back to tokenIn on Sushiswap
        uint256 finalBalance = exchangeTokenOnSushiswap(_tokenOut, _tokenIn, wethBalance);

        emit Debug("USDC Balance Before Camelot Swap", usdBalanceBefore);
        emit Debug("USDC Balance After Camelot Swap", usdBalanceAfterCamelot);
        emit Debug("WETH Balance After Camelot Swap", wethBalance);
        emit Debug("USDC final balance", finalBalance);

        uint256 currentBalance = IERC20(_tokenIn).balanceOf(address(this));
        require(currentBalance >= _initialBalance, "Arbitrage not profitable");

        return currentBalance;
    }

    function executeOperation(
        address _asset,
        uint256 _amount,
        uint256 _premium,
        address _initiator,
        bytes calldata /* params */
    ) public virtual override returns (bool) {
        require(msg.sender == address(POOL), "Caller is not the pool");
        require(_initiator == owner, "Unauthorized initiator");
        require(_asset == inTokenAddress, "Asset mismatch with arbitrage settings");

        // Execute arbitrage
        uint256 finalBalance = arbitrage(inTokenAddress, outTokenAddress, _amount);

        // Calculate total amount owed (loan + premium)
        uint256 amountOwed = _amount + _premium;
        require(finalBalance >= amountOwed, "Insufficient funds to repay flash loan");

        // Calculate profit
        uint256 profit = finalBalance - amountOwed;
        emit ArbitrageCompleted(profit);

        // Approve pool to take the owed amount
        IERC20(_asset).safeIncreaseAllowance(address(POOL), amountOwed);

        return true;
    }

    function getBalance(address _tokenAddress) external view returns (uint256) {
        return IERC20(_tokenAddress).balanceOf(address(this));
    }

    function withdraw(address _tokenAddress) external onlyOwner nonReentrant {
        require(_tokenAddress != address(0), "Invalid token address");
        IERC20 token = IERC20(_tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to withdraw");
        token.safeTransfer(msg.sender, balance);
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
