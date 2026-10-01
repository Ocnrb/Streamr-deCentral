// State shared by the app modules: the connected account and the DATA prices
import { OperatorLogic } from '../features/operator.js';

export const state = {
    // Authentication
    signer: null,
    myRealAddress: '',

    // Shared data (passed to modules)
    historicalDataPriceMap: null,
    dataPriceUSD: null,
};

/** Sets the connected account (null signer: none), also as window.appSigner for the modules that read it */
export function setAccount(signer, address = '') {
    state.signer = signer;
    state.myRealAddress = address;
    window.appSigner = signer;
}

export function syncOperatorState() {
    OperatorLogic.setSharedState({
        signer: state.signer,
        myRealAddress: state.myRealAddress,
        dataPriceUSD: state.dataPriceUSD,
        historicalDataPriceMap: state.historicalDataPriceMap
    });
}
