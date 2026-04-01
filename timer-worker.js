// ============================================
// DOTTI SENDER FULL - TIMER WORKER v3.2.2
// Web Worker para timers sem throttling em abas background
// Chrome throttle setTimeout para 1/min em abas inativas,
// mas Web Workers NAO sao afetados por esse throttling.
// ============================================

self.onmessage = function(e) {
    var data = e.data;
    if (data && data.action === 'setTimeout') {
        setTimeout(function() {
            self.postMessage({ id: data.id });
        }, data.delay || 0);
    }
};
