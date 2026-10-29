const leaf = (id, value) => ({ id, name: `节点 ${id}`, value, children: [] });
const deep = leaf('A-1-1-1-1-1', 15);
const tree = { id: 'root', name: '根节点', value: 0, children: [
    { ...leaf('A', 10), children: [
        { ...leaf('A-1', 11), children: [
            { ...leaf('A-1-1', 12), children: [
                { ...leaf('A-1-1-1', 13), children: [{ ...leaf('A-1-1-1-1', 14), children: [deep] }] },
                leaf('A-1-1-2', 16),
            ] }, leaf('A-1-2', 17),
        ] }, leaf('A-2', 18),
    ] },
    { ...leaf('B', 20), children: [{ ...leaf('B-1', 21), children: [leaf('B-1-1', 22), leaf('B-1-2', 23)] }] },
    leaf('C', 30),
] };
const cases = [];
const add = (id, name, input, note, standard) => cases.push({ id, name, input: typeof input === 'string' ? input : JSON.stringify(input, null, 2), note, standard });
add('01', '基本类型与嵌套对象', { id: 1, name: 'Alice', enabled: true, price: 1.25, profile: { age: 20, city: '上海' } }, '基础转换与嵌套对象');
add('02', '常见缩写命名', { user_id: 1, apiURL: 'https://example.com', HTTP_status: 200, uuid: 'u', enabled: true }, '检查 UserID、APIURL、HTTPStatus、UUID');
add('03', '七层递归树', tree, '对应前面约 100 行递归数据，预期 Children []Children');
add('04', '对象数组整数与浮点合并', [{ id: 1, value: 1 }, { id: 2, value: 1.25 }], '不能只按首个元素推断');
add('05', '数组对象字段缺失', [{ id: 1, name: 'Alice' }, { id: 2, enabled: true }], '观察缺失字段是否变成零值或新字段');
add('06', '混合类型数组', { id: 1, values: [1, 'text', true, { id: 2 }, null] }, '合理退化为 []any');
add('07', '数字数组包含 null', { id: 1, values: [1, null, 3] }, '不能悄悄把 null 转成 0');
add('08', '可空对象字段', [{ id: 1, name: null, enabled: null }, { id: 2, name: 'Alice', enabled: true }], '观察是否需要指针或 any');
add('09', '空根对象', {}, '应该生成可用的 Root 类型');
add('10', '嵌套空对象', { id: 1, config: {} }, '引用的 Config 类型必须存在');
add('11', '只包含空对象的数组', { id: 1, entries: [{}, {}] }, '引用的 Entries 类型必须存在');
add('12', '空数组', { id: 1, values: [] }, '没有类型证据时 []any 是合理的');
add('13', '多维数字数组', { id: 1, matrix: [[1, 2], [3.25, 4]] }, '合并多层数组的元素类型');
add('14', '数字键字典', { '100': { id: 100, name: 'A' }, '101': { id: 101, name: 'B' } }, '合理推断 map[string]RootValue');
add('15', 'UUID 键字典', { '550e8400-e29b-41d4-a716-446655440000': { id: 1, name: 'A' }, '550e8400-e29b-41d4-a716-446655440001': { id: 2, name: 'B' } }, '动态键不应生成奇怪字段名');
add('16', '多语言字典', { 'en-US': 'Hello', 'zh-CN': '你好', 'de-DE': 'Hallo' }, '合理推断 map[string]string');
add('17', '固定业务字段同为数字', { id: 1, age: 20, count: 3, total: 10 }, '同构业务字段仍应保留结构体');
add('18', 'Go 字段名碰撞', { user_id: 1, 'user-id': 2, userID: 3 }, '三个 JSON key 都会被规范化成 UserID');
add('19', '中文字段名碰撞', { 姓名: 'Alice', 年龄: 20, 启用: true }, '不能全部生成同名 Field');
add('20', '数字开头字段名', { '123abc': 'text', id: 1 }, '生成合法导出字段名');
add('21', '字段名包含双引号', { 'a"b': 'text', id: 1 }, '检查 Go struct tag 转义与实际解码');
add('22', '字段名包含反引号', { 'a`b': 'text', id: 1 }, '不能破坏 Go 原始字符串语法');
add('23', '字段名包含换行', { 'a\nb': 'text', id: 1 }, '检查 struct tag 的反射合法性');
add('24', '字段名包含反斜杠', { 'a\\b': 'text', id: 1 }, '检查 Go tag 内的转义');
add('25', 'root 字段与根类型同名', { id: 1, root: { id: 2, name: 'child' } }, '不应生成非法的 Root 直接递归');
add('26', '同名嵌套对象直接递归', { node: { id: 1, node: { id: 2, node: null } }, enabled: true }, '直接递归需要 *Node，或独立类型');
add('27', '不同分支同名对象', { billing: { address: { zip: 1000, street: 'A' }, active: true }, shipping: { address: { zip: '2000', country: 'CN' }, active: false } }, '不能仅凭末级名称强行合并不同结构');
add('28', 'map 与 struct 混合对象数组', [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }, { id: 1, name: 'Alice' }], '防止 map 样本在合并时丢失字段');
add('29', 'int64 范围的大整数', '{"id":9223372036854775807,"name":"max int64"}', '必须可从原始数字解码，不能误推断 string');
add('30', 'uint64 范围的大整数', '{"id":18446744073709551615,"name":"max uint64"}', '不能按 JS Number 精度推断或误推断 string');
add('31', '整数样式指数', '{"id":1,"value":1e3}', 'JSON 1e3 不能直接解码到 Go int');
add('32', '带小数部分的整数', '{"id":1,"value":1.0}', 'JSON 1.0 不能直接解码到 Go int');
add('33', '小数末尾零', '{"id":1,"value":1.2300}', '字面量保护不应令 number 被推断成 string');
add('34', '高精度小数', '{"id":1,"value":0.1234567890123456789}', '避免数字字面量哨兵误导 Go 类型');
add('35', '嵌套 JSON 字符串', { id: 1, payload: '{"user":"Alice","active":true}' }, 'payload 仍应是 string');
add('36', 'JSON5 与 undefined', "{id: 1, name: 'Alice', enabled: true, missing: undefined, tags: ['a',],}", '走与浏览器相同的兼容解析链路', '{"id":1,"name":"Alice","enabled":true,"missing":null,"tags":["a"]}');
add('37', '数组首元素为空对象', [{}, { id: 1, name: 'Alice' }], '后续元素提供类型证据，观察空对象是否补零值');
add('38', '同结构不同名称的兄弟节点', { source: { id: 1, name: 'A' }, target: { id: 2, name: 'B' } }, '可以共享类型，但两个独立类型也合法');
add('39', '根字符串', '"hello"', '合法 JSON 根原始值');
add('40', '根空数组', '[]', '合法 JSON 根空数组');
add('41', '递归树子节点新增字段', { ...tree, children: [{ ...tree.children[0], extra: 'child-only' }, ...tree.children.slice(1)] }, '递归样本应合并字段，同时标出缺失值风险');
add('42', '一万个对象的数组', Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `item-${i}`, value: i % 2 ? i / 10 : i, enabled: i % 2 === 0 })), '检验完整样本推断及转换耗时');
add('43', '空字符串字段名', { id: 1, '': 'empty-key' }, 'json:"" 会退回 Go 字段名，不能保留空 key');
add('44', '单独短横线字段名', { id: 1, '-': true }, 'json:"-" 表示忽略字段，不能照搬原 key');
add('45', '字段名包含逗号', { id: 1, 'a,b': 'comma-key' }, 'Go 的 json tag 使用逗号分隔选项');
add('46', '字段名类似 Go tag 选项', { id: 1, 'name,omitempty': 'option-like-key' }, '不能把原始 JSON key 误读为 name 和 omitempty');

add('47', '显式 null 与缺失字段同时出现', [{id: 1, value: null}, {id: 2, value: 3}, {id: 3}], '保留 null 和缺失之间的区别');
add('48', '可选字段保留零值和空容器', [{id: 1, value: 0, name: '', enabled: false, values: [], config: {}}, {id: 2}], 'omitempty 不能吞掉实际存在的零值');
add('49', '对象数组包含 null 和空对象', {id: 1, entries: [null, {id: 2}, {}]}, '保留 null、空对象和有字段的对象');
add('50', '多维数组包含 null 和空数组', {id: 1, values: [null, [], [1]]}, '保留 null 数组与空数组的区别');
add('51', '动态字典含大整数和 null', '{"0":null,"1":9223372036854775807}', '可空 map 值也保留数字精度');
add('52', '异构数组含大整数和高精度小数', '{"id":1,"values":[9223372036854775807,"text",{"value":0.1234567890123456789},null]}', 'any 解码不能吞掉高精度数字');
add('53', '特殊 key 与高精度数字混合', '{"a,b":"text","id":9223372036854775807}', 'map 降级仍保留数字精度');
add('54', '负数和超 int64 无符号整数混合', '[{"id":-1},{"id":18446744073709551615}]', '避免 uint64 不能解析负数');
add('55', '大整数和小数混合', '[{"value":9223372036854775807},{"value":1.25}]', '不能以 float64 吞掉整数精度');
add('56', '超过 uint64 的根数字', '184467440737095516150000', '根 json.Number 必须保留其 JSON 解码行为');
add('57', '高精度根小数', '0.1234567890123456789', '根 json.Number 采用类型别名');
add('58', '用户字符串类似旧数字哨兵', {'__HPN_START_7f3a9c__123__HPN_END_7f3a9c__': 'key', id: 1, payload: '__HPN_START_7f3a9c__456__HPN_END_7f3a9c__'}, '不能替换真实 key 或用户字符串');
add('59', '用户字符串伪造数字 wrapper', {id: 1, payload: '{"__jsonToolHighPrecisionNumber":true,"__jsonToolHighPrecisionNumberSecret":"fake","originalString":"123"}'}, '只识别当前解析器验证过的数字');
add('60', '自然字段名与自动后缀碰撞', {user_id: 1, 'user-id': 2, userID2: 3, '姓名': 'A', Field2: true}, '编号不能占用本来已有的字段名');
add('61', '不同分支同名对象保留具体类型', {billing: {address: {zip: 1000, street: 'A'}, active: true}, shipping: {address: {zip: '2000', country: 'CN'}, active: false}}, 'Address 与 Address2 不强行合并');
let chain = {id: 500, children: []};
for (let id = 499; id >= 0; id--) chain = {id, children: [chain]};
add('62', '五百层递归数组链', chain, '递归定义不能按深度无限复制');
add('63', '混合 map/struct 数组样本逆序', [{id: 1, name: 'Alice'}, {a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8}], '验证样本顺序不影响字段保留');
add('64', 'JSON5 非有限数字', "{id: 1, nan: NaN, infinity: Infinity, values: [1, -Infinity]}", '与格式化一致，归一成 null', '{"id":1,"nan":null,"infinity":null,"values":[1,null]}');
add('65', '超出 float64 范围的数字', '{"id":1,"value":1e400}', '保留合法 JSON 数字，不能变成 Infinity');
add('66', '多个动态键具有不同对象字段', {"100": {id: 1, name: 'A'}, "101": {id: 2, enabled: false}}, '动态字典统一合并所有值样本');
add('67', '空字典和全 null 的动态字典', {id: 1, entries: {"100": null, "101": null}, config: {}}, '空对象必须可用，全 null 的数字键仍按字典处理');
add('68', '指数与负零数字', '{"id":1,"small":1e-400,"zero":-0,"exponent":1e+3}', '极小数和指数保留语义');
export const goConversionCases = cases;
