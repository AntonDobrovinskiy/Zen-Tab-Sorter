function universalSort(arr, options = {}) {
    const {
        ignoreCase = true,
        natural = true,
        reverse = false,
        sortKey = null,
        customCompare = null,
        removeAccents = true,
        removePunctuation = false
    } = options;

    const collator = new Intl.Collator(undefined, {
        numeric: natural,
        sensitivity: ignoreCase ? 'base' : 'variant'
    });

    function normalize(str) {
        if (typeof str !== 'string') return str;
        
        let result = str;

        if (removeAccents) {
            result = result.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        }

        if (removePunctuation) {
            result = result.replace(/[!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~]/g, '');
        }

        return result;
    }

    function compare(a, b) {
        if (customCompare) {
            return customCompare(a, b);
        }

        let valA = sortKey ? a[sortKey] : a;
        let valB = sortKey ? b[sortKey] : b;

        valA = normalize(valA);
        valB = normalize(valB);

        return collator.compare(valA, valB);
    }

    const sorted = [...arr].sort(compare);
    return reverse ? sorted.reverse() : sorted;
}

window.universalSort = universalSort;
