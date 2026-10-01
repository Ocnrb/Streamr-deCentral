// libs.js - Leaflet's CSS, and the libraries as globals for the scripts loaded outside the bundle (the MapLibre
// plugin needs L) and for the console. The app's modules import what they use themselves.
import { ethers } from 'ethers';
import Chart from 'chart.js/auto';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

window.ethers = ethers;
window.Chart = Chart;
window.L = L;
