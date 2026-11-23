# -*- coding: utf-8 -*-
"""韩语动词/形容词变位引擎 → data/conjugations.json"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BASE = 0xAC00
IEUNG = 11                      # ㅇ 初声索引（不是 0！）
RIEUL = 5                       # ㄹ 初声索引
T_RIEUL, T_BIEUP, T_NIEUN, T_SSANG_SIOT = 8, 17, 4, 20

V_ORDER = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"]
IDX = {c: i for i, c in enumerate(V_ORDER)}

EUN = chr(BASE + (IEUNG * 21 + IDX["ㅡ"]) * 28 + T_NIEUN)      # 은
EUL = chr(BASE + (IEUNG * 21 + IDX["ㅡ"]) * 28 + T_RIEUL)      # 을
A, EO = IDX["ㅏ"], IDX["ㅓ"]


def decompose(ch):
    code = ord(ch) - BASE
    if 0 <= code < 11172:
        return code // 588, (code % 588) // 28, code % 28
    return None


def compose(L, V, T=0):
    return chr(BASE + (L * 21 + V) * 28 + T)


def vowel_char(ch):
    d = decompose(ch)
    return V_ORDER[d[1]] if d else None


def is_yang(v_char):
    return v_char in ("ㅏ", "ㅗ")


MERGE = {
    ("ㅏ","ㅏ"):"ㅏ", ("ㅓ","ㅓ"):"ㅓ", ("ㅗ","ㅏ"):"ㅘ", ("ㅜ","ㅓ"):"ㅝ",
    ("ㅣ","ㅓ"):"ㅕ", ("ㅡ","ㅓ"):"ㅓ", ("ㅐ","ㅓ"):"ㅐ", ("ㅔ","ㅓ"):"ㅔ",
    ("ㅚ","ㅓ"):"ㅙ", ("ㅑ","ㅏ"):"ㅑ", ("ㅕ","ㅓ"):"ㅕ",
    ("ㅕ","ㅏ"):"ㅕ", ("ㅑ","ㅓ"):"ㅒ",
}


class Conj:
    def __init__(self, word, pos, irr):
        self.word = word
        self.pos = pos
        self.irr = irr or "none"
        self.stem = word[:-1] if word.endswith("다") else word

    def d(self, i=-1):
        return decompose(self.stem[i])

    def ret(self, T):
        """把词干末字收音设成 T"""
        L, V, _ = self.d()
        return self.stem[:-1] + compose(L, V, T)

    def drop_t(self):
        L, V, _ = self.d()
        return self.stem[:-1] + compose(L, V, 0)

    # ===== 元音起首（아/어 系列）=====
    def ao(self, ssang=False):
        stem, irr = self.stem, self.irr
        Tssang = T_SSANG_SIOT if ssang else 0

        if irr == "하" or stem.endswith("하"):
            L, V, _ = decompose(stem[-1])
            return stem[:-1] + compose(L, IDX["ㅐ"], Tssang)

        L, V, T = self.d()
        head = stem[:-1]

        if irr == "ㅂ" and T == T_BIEUP:
            # ㅂ 不规则：词干元音为 ㅗ 时合流为 와（돕다→도와），其余合流为 워（춥다→추워）
            merged = "ㅘ" if V_ORDER[V] == "ㅗ" else "ㅝ"
            return self.drop_t() + compose(IEUNG, IDX[merged], Tssang)

        if irr == "르" and V == IDX["ㅡ"] and T == 0 and len(stem) >= 2:
            pl, pv, _ = decompose(stem[-2])
            vc = "ㅏ" if is_yang(V_ORDER[pv]) else "ㅓ"
            return head[:-1] + compose(pl, pv, T_RIEUL) + compose(RIEUL, IDX[vc], Tssang)

        if irr == "으" and V == IDX["ㅡ"] and T == 0:
            if len(stem) == 1:
                vc = "ㅓ"
            else:
                pv = V_ORDER[decompose(stem[-2])[1]]
                vc = "ㅏ" if is_yang(pv) else "ㅓ"
            return head + compose(L, IDX[vc], Tssang)

        if irr == "ㅜ" and V == IDX["ㅜ"] and T == 0:
            return head + compose(L, EO, Tssang)

        if irr == "ㄷ" and T == 7:
            return Conj(head + compose(L, V, T_RIEUL) + "다", self.pos, "none").ao(ssang)

        if irr == "ㅅ" and T == 19:
            return Conj(head + compose(L, V, 0) + "다", self.pos, "none").ao(ssang)

        if irr == "ㅎ" and T == 27:
            return Conj(head + compose(L, V, 0) + "다", self.pos, "none").ao(ssang)

        vc = "ㅏ" if is_yang(V_ORDER[V]) else "ㅓ"
        if T != 0:
            return stem + compose(IEUNG, IDX[vc], Tssang)
        # ㅟ / ㅢ 不和 어 缩合：쉬다→쉬어요、뛰다→뛰어요、희다→희어요（不是 숴/뛰워）
        if V_ORDER[V] in ("ㅟ", "ㅢ"):
            return stem + compose(IEUNG, IDX[vc], Tssang)
        merged = MERGE.get((V_ORDER[V], vc), vc)
        return head + compose(L, IDX[merged], Tssang)

    # ===== 辅音/收音型 =====
    def _nil(self):
        """去掉 ㄹ 收音（ㄹ 在 ㄴ/ㅂ/ㅅ 前脱落）"""
        L, V, T = self.d()
        return self.stem[:-1] + compose(L, V, 0) if T == T_RIEUL else self.stem

    def bnida(self):
        L, V, T = self.d()
        base, T = (self._nil(), 0) if T == T_RIEUL else (self.stem, T)
        if T != 0:
            return base + "습니다"
        L2, V2, _ = decompose(base[-1])
        return base[:-1] + compose(L2, V2, T_BIEUP) + "니다"

    def _u_form(self):
        """ㅂ 不规则词干的 우 形态（더우 / 추우）"""
        return self.drop_t() + compose(IEUNG, IDX["ㅜ"])

    def adnominal_T(self, t_index):
        """-(으)ㄴ / -(으)ㄹ : 无收音→末字设收音；有收音→加 은/을"""
        L, V, T = self.d()
        # 있다/없다 这类形容词的现在定语形接 -는（없는 사람），不接 은
        if t_index == T_NIEUN and (self.stem.endswith("있") or self.stem.endswith("없")):
            return self.stem + "는"
        if self.irr == "ㅂ" and T == T_BIEUP:
            base = self._u_form()                     # 더우
            bL, bV, _ = decompose(base[-1])
            return base[:-1] + compose(bL, bV, t_index)   # 더운
        if T == 0:
            return self.stem[:-1] + compose(L, V, t_index)
        if T == T_RIEUL:
            return self.stem[:-1] + compose(L, V, t_index)
        return self.stem + (EUN if t_index == T_NIEUN else EUL)

    def plus_ni(self, text):
        """-(으)니까 / -(으)면"""
        L, V, T = self.d()
        if self.irr == "ㅂ" and T == T_BIEUP:
            return self._u_form() + text
        if T == 0:
            return self.stem + text
        if T == T_RIEUL:
            # ㄹ 只在 ㄴ 前脱落：힘드니까，但 힘들면 保留 ㄹ
            return (self.stem if text == "면" else self._nil()) + text
        return self.stem + "으" + text

    def forms(self):
        past = self.ao(ssang=True)
        s = self.stem
        out = [
            ("现在·非格式体·敬语", "해요체", self.ao() + "요", "日常最常用的礼貌体：对陌生人、长辈、同事"),
            ("现在·格式体·敬语", "합니다체", self.bnida(), "正式场合／新闻播报／面试"),
            ("现在·半语", "해체", self.ao(), "对朋友、晚辈；韩剧里出现频率最高"),
            ("过去·非格式体·敬语", "과거 해요체", past + "어요", "-았/었- 表完成"),
            ("过去·格式体·敬语", "과거 합니다체", past + "습니다", ""),
            ("过去·半语", "과거 해체", past + "어", ""),
            ("将来·推测·敬语", "미래 해요체", s + "겠어요", "-겠- 表意志或推测"),
            ("将来·格式体·敬语", "미래 합니다체", s + "겠습니다", ""),
        ]
        if self.pos == "动词":
            out.append(("定语形·现在", "관형형 현재", self._nil() + "는", "动词现在时定语：먹는 사람（吃的人）"))
        else:
            out.append(("定语形·现在", "관형형 현재", self.adnominal_T(T_NIEUN), "形容词现在时定语：좋은 사람（好人）"))
        out += [
            ("定语形·过去", "관형형 과거", self.adnominal_T(T_NIEUN), "먹은 빵（吃过的面包）"),
            ("定语形·将来", "관형형 미래", self.adnominal_T(T_RIEUL), "먹을 빵（要吃的面包）"),
            ("连接·并列/先后", "-고", s + "고", "먹고 갈게요（吃完再去）"),
            ("连接·转折", "-지만", s + "지만", "비싸지만 좋아요（贵但好）"),
            ("连接·原因", "-(으)니까", self.plus_ni("니까"), "비가 오니까 우산을 써요"),
            ("条件·如果", "-(으)면", self.plus_ni("면"), "시간이 있으면 와요"),
        ]
        return out


def conj_word(w):
    # 国语院 A 级全表那批没有逐词标注不规则类型，硬算会出错（比如 모르다 会得到 모르어요），
    # 所以只给人工标注过 irregular 的那批评选词出变位表。
    if w.get("src") == "nikl":
        return None
    if w["pos"] not in ("动词", "形容词") or not w["korean"].endswith("다"):
        return None
    c = Conj(w["korean"], w["pos"], w.get("irregular", "none"))
    return [{"label": l, "tag": t, "form": f, "note": n} for (l, t, f, n) in c.forms()]


CASES = [
    ("쉬다","动词","none",{"해요체":"쉬어요","합니다체":"쉽니다","과거 해요체":"쉬었어요","관형형 현재":"쉬는"}),
    ("뛰다","动词","none",{"해요체":"뛰어요","과거 해요체":"뛰었어요","-(으)면":"뛰면"}),
    ("재미없다","形容词","none",{"해요체":"재미없어요","관형형 현재":"재미없는"}),
    ("맛없다","形容词","none",{"관형형 현재":"맛없는"}),
    ("힘들다","形容词","ㄹ",{"해요체":"힘들어요","관형형 현재":"힘든","-(으)니까":"힘드니까","-(으)면":"힘들면"}),
    ("불다","动词","ㄹ",{"해요체":"불어요","합니다체":"붑니다","관형형 현재":"부는","-(으)면":"불면"}),
    ("도와주다","动词","none",{"해요체":"도와줘요","과거 해요체":"도와줬어요"}),
    ("먹다","动词","none",{"해요체":"먹어요","합니다체":"먹습니다","해체":"먹어","과거 해요체":"먹었어요",
                          "과거 합니다체":"먹었습니다","과거 해체":"먹었어","미래 해요체":"먹겠어요","관형형 현재":"먹는"}),
    ("가다","动词","none",{"해요체":"가요","합니다체":"갑니다","과거 해요체":"갔어요","관형형 현재":"가는","관형형 미래":"갈"}),
    ("오다","动词","none",{"해요체":"와요","과거 해요체":"왔어요"}),
    ("하다","动词","하",{"해요체":"해요","합니다체":"합니다","과거 해요체":"했어요","과거 합니다체":"했습니다","해체":"해"}),
    ("크다","形容词","으",{"해요체":"커요","합니다체":"큽니다","관형형 현재":"큰","과거 해요체":"컸어요"}),
    ("쓰다","动词","으",{"해요체":"써요","합니다체":"씁니다","과거 해요체":"썼어요"}),
    ("바쁘다","形容词","으",{"해요체":"바빠요","과거 해요체":"바빴어요"}),
    ("아프다","形容词","으",{"해요체":"아파요"}),
    ("예쁘다","形容词","으",{"해요체":"예뻐요"}),
    ("춥다","形容词","ㅂ",{"해요체":"추워요","합니다체":"춥습니다","과거 해요체":"추웠어요"}),
    ("덥다","形容词","ㅂ",{"해요체":"더워요","관형형 현재":"더운"}),
    ("돕다","动词","ㅂ",{"해요체":"도와요","과거 해요체":"도왔어요"}),
    ("귀엽다","形容词","ㅂ",{"해요체":"귀여워요"}),
    ("듣다","动词","ㄷ",{"해요체":"들어요","과거 해요체":"들었어요","합니다체":"듣습니다"}),
    ("걷다","动词","ㄷ",{"해요체":"걸어요"}),
    ("씻다","动词","none",{"해요체":"씻어요","과거 해요체":"씻었어요"}),
    ("웃다","动词","none",{"해요체":"웃어요"}),
    ("모르다","动词","르",{"해요체":"몰라요","과거 해요체":"몰랐어요"}),
    ("부르다","动词","르",{"해요체":"불러요"}),
    ("빠르다","形容词","르",{"해요체":"빨라요"}),
    ("고르다","动词","르",{"해요체":"골라요"}),
    ("살다","动词","ㄹ",{"해요체":"살아요","합니다체":"삽니다","관형형 현재":"사는","해체":"살아","-(으)니까":"사니까"}),
    ("알다","动词","ㄹ",{"해요체":"알아요","합니다체":"압니다"}),
    ("멀다","形容词","ㄹ",{"해요체":"멀어요","관형형 현재":"먼"}),
    ("길다","形容词","ㄹ",{"해요체":"길어요","관형형 현재":"긴"}),
    ("좋다","形容词","none",{"해요체":"좋아요","관형형 현재":"좋은"}),
    ("있다","动词","none",{"해요체":"있어요","합니다체":"있습니다"}),
    ("없다","形容词","none",{"해요체":"없어요"}),
    ("배우다","动词","none",{"해요체":"배워요","과거 해요체":"배웠어요"}),
    ("기다리다","动词","none",{"해요체":"기다려요"}),
    ("마시다","动词","none",{"해요체":"마셔요"}),
    ("만들다","动词","ㄹ",{"해요체":"만들어요","합니다체":"만듭니다"}),
    ("어렵다","形容词","ㅂ",{"해요체":"어려워요"}),
    ("가깝다","形容词","ㅂ",{"해요체":"가까워요"}),
    # ---- TOPIK 中级扩展词（第二批）----
    ("시작하다","动词","하",{"해요체":"시작해요","합니다체":"시작합니다","과거 해요체":"시작했어요","관형형 현재":"시작하는"}),
    ("늘다","动词","ㄹ",{"해요체":"늘어요","합니다체":"늡니다","과거 해요체":"늘었어요",
                        "관형형 현재":"느는","-(으)니까":"느니까"}),
    ("줄다","动词","ㄹ",{"해요체":"줄어요","합니다체":"줍니다","관형형 현재":"주는"}),
    ("오르다","动词","르",{"해요체":"올라요","합니다체":"오릅니다","과거 해요체":"올랐어요","관형형 현재":"오르는"}),
    ("게으르다","形容词","르",{"해요체":"게을러요","관형형 현재":"게으른"}),
    ("끄다","动词","으",{"해요체":"꺼요","합니다체":"끕니다","관형형 현재":"끄는","관형형 과거":"끈"}),
    ("슬프다","形容词","으",{"해요체":"슬퍼요","합니다체":"슬픕니다","관형형 현재":"슬픈"}),
    ("기쁘다","形容词","으",{"해요체":"기뻐요","관형형 현재":"기쁜"}),
    ("외롭다","形容词","ㅂ",{"해요체":"외로와요","관형형 현재":"외로운","-(으)니까":"외로우니까"}),
    ("돌보다","动词","none",{"해요체":"돌봐요","관형형 과거":"돌본"}),
    ("물어보다","动词","none",{"해요체":"물어봐요","관형형 현재":"물어보는"}),
    ("챙기다","动词","none",{"해요체":"챙겨요","과거 해요체":"챙겼어요"}),
    ("중요하다","形容词","하",{"해요체":"중요해요","관형형 현재":"중요한"}),
    ("따뜻하다","形容词","하",{"해요체":"따뜻해요","관형형 미래":"따뜻할"}),
    ("비슷하다","形容词","하",{"해요체":"비슷해요"}),
    ("내리다","动词","none",{"해요체":"내려요","관형형 현재":"내리는"}),
]


def main():
    words = json.load(open(os.path.join(DATA, "words.json"), encoding="utf-8"))
    out = {}
    for w in words:
        cw = conj_word(w)
        if cw:
            out[w["id"]] = {"korean": w["korean"], "pos": w["pos"], "rows": cw}
    json.dump(out, open(os.path.join(DATA, "conjugations.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    fail = tot = 0
    for word, pos, irr, expect in CASES:
        got = {r[1]: r[2] for r in Conj(word, pos, irr).forms()}
        for tag, want in expect.items():
            tot += 1
            if got.get(tag) != want:
                fail += 1
                print("  [FAIL] %-8s %-12s got=%-12s want=%s" % (word, tag, got.get(tag), want))
    print("变位自测：%d/%d 通过" % (tot - fail, tot))
    print("变位表：%d 词条" % len(out))
    return fail


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
