export const urls = [1, 2, 3, 4].map((i) => 'https://www.archdaily.com/' + i + '/trial-fixture');
export const photo = 'https://images.adsttc.com/fixture/exterior.jpg';
export const brief = '深圳社区图书馆，改造 1200 平方米厂房，容纳亲子阅览与夜间活动。';
export function fixtureReport() {
  return {
    project: {
      titleCn: '深圳社区图书馆',
      titleEn: 'Shenzhen Library',
      location: '深圳',
      area: '1200 ㎡',
      type: '社区图书馆',
      abstract: '保留<strong>厂房结构</strong>。',
      requirements: ['分时共用'],
    },
    cases: urls.map((sourceUrl, i) => ({
      titleCn: '测试案例 ' + (i + 1),
      titleEn: 'Case ' + (i + 1),
      architect: '示例事务所',
      year: '2020',
      area: '1200 ㎡',
      location: '深圳',
      typology: '公共建筑',
      relevance: '既有空间适应性再利用。',
      sourceUrl,
      images: ['EXTERIOR', 'INTERIOR', 'PLAN'].map((label, j) => ({
        label,
        url: j === 0 ? photo : '',
        analysisLabel: label,
        analysisBody: '沿场地边界设置共享空间。',
      })),
    })),
    comparison: { intro: '对比开放时段和公共入口。' },
    takeaways: ['场地回应', '形式操作', '空间氛围', '材料逻辑', '运营策略'].map((labelCn, i) => ({
      labelCn,
      labelEn: [
        'Site Response',
        'Formal Move',
        'Spatial Atmosphere',
        'Material Logic',
        'Operational Strategy',
      ][i],
      lesson: '保留原有边界。',
      direction: '独立设置夜间入口。',
    })),
  };
}
