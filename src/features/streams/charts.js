// A sponsorship's chart (APY, stake, payouts) and its controls
import * as Utils from '../../core/utils.js';
import { state, detailState } from './state.js';
import Chart from 'chart.js/auto';

export function renderSponsorshipCharts(dailyData) {
    if (!dailyData || dailyData.length === 0) {
        return;
    }
    
    // Store the chart data
    detailState.chartData = dailyData;
    detailState.currentChartType = 'apy';
    detailState.currentViewMode = 'data';
    detailState.currentTimeframe = 'all';
    
    // Initial render
    updateUnifiedChart();
}

/**
 * Update unified chart based on current state
 */
function updateUnifiedChart() {
    const dailyData = detailState.chartData;
    if (!dailyData || dailyData.length === 0) return;
    
    // Destroy existing chart
    if (detailState.chart) {
        detailState.chart.destroy();
        detailState.chart = null;
    }
    
    // Filter data by timeframe
    let filteredData = dailyData;
    if (detailState.currentTimeframe !== 'all') {
        const days = parseInt(detailState.currentTimeframe);
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        filteredData = dailyData.filter(d => parseInt(d.date) * 1000 >= cutoff);
    }
    
    if (filteredData.length === 0) {
        filteredData = dailyData.slice(-7); // Fallback to last 7 days
    }
    
    const labels = filteredData.map(d => new Date(parseInt(d.date) * 1000).toLocaleDateString());
    const dataPriceUSD = state.dataPriceUSD || 0;
    const useUsd = detailState.currentViewMode === 'usd' && dataPriceUSD > 0;
    
    // Show/hide USD toggle based on chart type
    const viewButtons = document.getElementById('stream-chart-view-buttons');
    if (viewButtons) {
        viewButtons.classList.toggle('hidden', detailState.currentChartType !== 'stake');
    }
    
    // Prepare data based on chart type
    let chartData, chartColor, chartLabel, chartType, isStepped;
    
    switch (detailState.currentChartType) {
        case 'apy':
            chartData = filteredData.map(d => parseFloat(d.spotAPY || 0) * 100);
            chartColor = '#22c55e';
            chartLabel = 'APY (%)';
            chartType = 'line';
            isStepped = false;
            break;
        case 'stake':
            chartData = filteredData.map(d => {
                const val = Utils.convertWeiToData(d.totalStakedWei || '0');
                return useUsd ? val * dataPriceUSD : val;
            });
            chartColor = '#3b82f6';
            chartLabel = useUsd ? 'Staked (USD)' : 'Staked (DATA)';
            chartType = 'bar';
            isStepped = false;
            break;
        case 'operators':
            chartData = filteredData.map(d => parseInt(d.operatorCount || 0));
            chartColor = '#8b5cf6';
            chartLabel = 'Operators';
            chartType = 'line';
            isStepped = true;
            break;
    }
    
    const ctx = document.getElementById('stream-unified-chart')?.getContext('2d');
    if (!ctx) return;
    
    const chartConfig = {
        type: chartType,
        data: {
            labels,
            datasets: [{
                data: chartData,
                borderColor: chartColor,
                backgroundColor: chartType === 'bar' ? chartColor : `${chartColor}20`,
                fill: chartType === 'line',
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2,
                borderRadius: chartType === 'bar' ? 4 : 0,
                ...(isStepped ? { stepped: 'middle' } : {})
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1E1E1E',
                    borderColor: '#333',
                    borderWidth: 1,
                    titleColor: '#fff',
                    bodyColor: '#a3a3a3',
                    titleFont: { family: 'Inter, system-ui, sans-serif', size: 12 },
                    bodyFont: { family: 'Inter, system-ui, sans-serif', size: 11 },
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        label: function(context) {
                            const value = context.raw;
                            if (detailState.currentChartType === 'apy') {
                                return `${value.toFixed(2)}%`;
                            } else if (detailState.currentChartType === 'stake') {
                                const prefix = useUsd ? '$' : '';
                                const suffix = useUsd ? '' : ' DATA';
                                return `${prefix}${Utils.formatBigNumber(value)}${suffix}`;
                            } else {
                                return `${value} operators`;
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: { display: false },
                    ticks: { 
                        color: '#666', 
                        font: { size: 10, family: 'Inter, system-ui, sans-serif' },
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 8
                    }
                },
                y: {
                    grid: { color: '#333', drawBorder: false },
                    ticks: { 
                        color: '#666', 
                        font: { size: 10, family: 'Inter, system-ui, sans-serif' },
                        callback: function(value) {
                            if (detailState.currentChartType === 'apy') {
                                return value + '%';
                            } else if (detailState.currentChartType === 'stake') {
                                const prefix = useUsd ? '$' : '';
                                return prefix + Utils.formatBigNumber(value);
                            }
                            return value;
                        }
                    }
                }
            }
        }
    };
    
    detailState.chart = new Chart(ctx, chartConfig);
}

/**
 * Setup chart event listeners for pills
 */
let chartListenersSetup = false;

export function setupChartEventListeners() {
    if (chartListenersSetup) return;
    chartListenersSetup = true;
    
    // Chart type pills
    const chartTypeTabs = document.getElementById('stream-chart-type-tabs');
    if (chartTypeTabs) {
        chartTypeTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-chart-type]');
            if (!btn) return;
            
            const chartType = btn.getAttribute('data-stream-chart-type');
            detailState.currentChartType = chartType;
            
            // Update pill styling
            chartTypeTabs.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-800', 'text-white');
                b.classList.add('text-gray-400');
            });
            btn.classList.add('bg-blue-800', 'text-white');
            btn.classList.remove('text-gray-400');
            
            updateUnifiedChart();
        });
    }
    
    // View mode pills (DATA/USD)
    const viewButtons = document.getElementById('stream-chart-view-buttons');
    if (viewButtons) {
        viewButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-view]');
            if (!btn) return;
            
            const viewMode = btn.getAttribute('data-stream-view');
            detailState.currentViewMode = viewMode;
            
            // Update pill styling
            viewButtons.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-800', 'text-white');
                b.classList.add('text-gray-300');
            });
            btn.classList.add('bg-blue-800', 'text-white');
            btn.classList.remove('text-gray-300');
            
            updateUnifiedChart();
        });
    }
    
    // Timeframe pills
    const timeframeButtons = document.getElementById('stream-chart-timeframe-buttons');
    if (timeframeButtons) {
        timeframeButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-stream-days]');
            if (!btn) return;
            
            const days = btn.getAttribute('data-stream-days');
            detailState.currentTimeframe = days;
            
            // Update pill styling
            timeframeButtons.querySelectorAll('button').forEach(b => {
                b.classList.remove('bg-blue-800', 'text-white', 'shadow-sm');
                b.classList.add('text-gray-300');
            });
            btn.classList.add('bg-blue-800', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-300');
            
            updateUnifiedChart();
        });
    }
}

/** The chart's listeners are set up again with the next sponsorship */
export function resetChartListeners() {
    chartListenersSetup = false;
}
