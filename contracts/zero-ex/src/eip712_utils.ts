export interface EIP712Domain {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
}

/**
 * Create an exchange proxy EIP712 domain.
 */
export function createExchangeProxyEIP712Domain(verifyingContract: string, chainId: number = 1): EIP712Domain {
    return {
        chainId,
        verifyingContract,
        name: 'ZeroEx',
        version: '1.0.0',
    };
}
