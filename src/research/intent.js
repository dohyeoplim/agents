export function researchIntent(text) {
    const value = text.trim();
    if (/^!stop\s*$/i.test(value)) return "pause";
    if (/^!research(?:\s|$)/i.test(value)) return "new";
    if (/(?:딥\s*리서치|심층\s*조사|deep\s+research)/i.test(value) &&
        !/(?:하지\s*마|안\s*해|취소|don't|do not|what is|뭐야|무엇)/i.test(value) &&
        /(?:해\s*줘|해주세요|해보|하자|시작해|시작하자|진행해|진행하자|부탁|please|start|research\s+(?:on|about))/i
            .test(value)) return "new";
    if (/^(?:그대로\s*)?(?:시작(?:해|하자|해줘)?|start|go)[.!\s]*$/i.test(value)) return "start";
    if (/^(?:어디까지.*|진행\s*(?:상황|상태).*|status)[?!.\s]*$/i.test(value)) return "status";
    if (/^(?:잠깐\s*)?(?:멈춰|중지|일시\s*정지|pause|stop)[.!\s]*$/i.test(value)) return "pause";
    if (/^(?:이어서\s*(?:해|해줘|조사해)|재개|resume)[.!\s]*$/i.test(value)) return "resume";
    if (/^(?:지금까지.*(?:정리|요약).*|summarize)[.!\s]*$/i.test(value)) return "summarize";
    if (/^(?:여기까지.*마무리.*|마무리해|finish)[.!\s]*$/i.test(value)) return "finish";
    return null;
}
