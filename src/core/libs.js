// libs.js - Libraries from npm (versions pinned in package.json), shared as globals: the app's modules use them
// that way, and so do the scripts loaded later (the MapLibre plugin needs L). Imported first by main.js.
import { ethers } from 'ethers';
import Chart from 'chart.js/auto';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

window.ethers = ethers;
window.Chart = Chart;
window.L = L;
