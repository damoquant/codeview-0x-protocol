###############################
Releases
###############################

This page outlines upcoming releases and expected changes.

Tinker (Est November 12th, 2020)
-------------------

- Upgrade features to allow allowances set on the ExhcangeProxy contract. This will fallback to the Allowance Target.
- Deploy VIP PLP feature. This introduces a new event that is emitted by the Exchange Proxy when filling through the VIP PLP.

.. code-block:: solidity

    event LiquidityProviderSwap(
        address inputToken,
        address outputToken,
        uint256 inputTokenAmount,
        uint256 outputTokenAmount,
        address provider,
        address recipient
    );


Tailor (Est November 17th, 2020 #1)
----------------------

- Deploy feature that implements V4 Limit and RFQ orders (see the `Orders Page <../basics/orders.html>`_).
  This enables us to fill V4 limit orders through the Exchange Proxy, but does not yet allow aggregation.
- New events will be introduced; they will be shared once finalized.

Soldier (Est November 17th, 2020 #2
----------------------
- New PLP's. At this point, PLP instances will no longer emit `ERC20BridgeTransfer` events.

Sailor (Est November 24th, 2020)
-------------------
- A new transformer (like FillQuoteTransformer) that aggregates V4 orders instead of forwarding to Exchange V3.
- This enables us to run simbot trials against V4 before the external audit begins.
- WE DO NOT expect teams to be upgraded to V4 at this point; they can continue using the existing FillQuoteTransformer.
  At this point teams can begin testing their V4 tooling.
