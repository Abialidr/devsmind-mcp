import { formatDate } from '../utils/dates';

// Mini-program-style factory. `WidgetComponent` is not a real declaration; the members
// live inside methods:{}. A method node must link only to what IT calls.
Component({
  data: { count: 0 },
  methods: {
    onRefresh() {
      return formatDate('2020-01-01');
    },
    onReset() {
      return 0;
    }
  }
});
