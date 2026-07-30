<template>
  <div class="widget">{{ label }}</div>
</template>

<script lang="ts">
export function widgetHelper(x: number): number {
  return x * 3;
}

export default {
  name: 'Widget',
  props: ['label']
};
</script>

<style scoped>
.widget { color: red; }
</style>
