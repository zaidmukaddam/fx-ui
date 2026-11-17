use super::*;
use gpui_kit::base::input::HighlightStyleResolver;
use gpui_kit::component::highlighter::SyntaxHighlighter;
use gpui_kit::component::{Rope, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClipboardItem, FontStyle, FontWeight, HighlightStyle, Hsla,
    InteractiveElement as _, InteractiveText, IntoElement, ParentElement as _,
    StatefulInteractiveElement as _, StrikethroughStyle, Styled as _, StyledText, TextRun, div,
    font, px,
};
use markdown::mdast::Node;
use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::Hasher as _;
use std::ops::Range;
use std::rc::Rc;

struct CodeColors;

impl HighlightStyleResolver for CodeColors {
    fn style(&self, name: &str) -> Option<HighlightStyle> {
        let is = |prefix: &str| name.starts_with(prefix);
        let color = if is("variable.parameter") {
            amber_900()
        } else if is("comment") {
            gray_700()
        } else if is("string") {
            green_900()
        } else if is("keyword") || is("tag") {
            pink_900()
        } else if is("function") || is("constructor") || is("attribute") {
            purple_900()
        } else if is("number") || is("boolean") || is("constant") || is("type") || is("enum") {
            blue_900()
        } else if is("punctuation") || is("operator") {
            gray_900()
        } else {
            return None;
        };
        Some(HighlightStyle {
            color: Some(color),
            ..Default::default()
        })
    }
}

type Colors = Rc<Vec<(Range<usize>, HighlightStyle)>>;

struct Recent<V> {
    young: HashMap<u64, V>,
    old: HashMap<u64, V>,
    room: usize,
}

impl<V: Clone> Recent<V> {
    fn new(room: usize) -> Self {
        Self {
            young: HashMap::new(),
            old: HashMap::new(),
            room,
        }
    }

    fn get_or(&mut self, key: u64, make: impl FnOnce() -> V) -> V {
        if let Some(value) = self.young.get(&key) {
            return value.clone();
        }
        let value = self.old.remove(&key).unwrap_or_else(make);
        if self.young.len() >= self.room {
            self.old = std::mem::take(&mut self.young);
        }
        self.young.insert(key, value.clone());
        value
    }
}

fn key_of(parts: impl std::hash::Hash) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

thread_local! {
    static COLORED: RefCell<Recent<Colors>> = RefCell::new(Recent::new(256));
    static PARSED: RefCell<Recent<Rc<Option<Node>>>> = RefCell::new(Recent::new(512));
}

fn highlights(lang: Option<&str>, code: &str) -> Colors {
    let Some(lang) = lang.filter(|l| !l.is_empty()) else {
        return Rc::default();
    };
    COLORED.with_borrow_mut(|cache| {
        cache.get_or(key_of((lang, code)), || {
            let mut highlighter = SyntaxHighlighter::new(lang);
            highlighter.update(None, &Rope::from_str(code), None);
            Rc::new(highlighter.styles(&(0..code.len()), &CodeColors))
        })
    })
}

fn parsed(source: &str) -> Rc<Option<Node>> {
    PARSED.with_borrow_mut(|cache| {
        cache.get_or(key_of(source), || {
            Rc::new(markdown::to_mdast(source, &markdown::ParseOptions::gfm()).ok())
        })
    })
}

#[derive(Clone, Copy, Default)]
struct Inline {
    bold: bool,
    italic: bool,
    code: bool,
    strike: bool,
    link: bool,
}

#[derive(Default)]
struct Line {
    text: String,
    runs: Vec<TextRun>,
    links: Vec<(Range<usize>, String)>,
}

impl Line {
    fn push(&mut self, piece: &str, style: Inline, color: Hsla) {
        if piece.is_empty() {
            return;
        }
        let mut face = font(if style.code { MONO } else { sans() });
        if style.bold {
            face.weight = FontWeight::SEMIBOLD;
        }
        if style.italic {
            face.style = FontStyle::Italic;
        }
        self.text.push_str(piece);
        self.runs.push(TextRun {
            len: piece.len(),
            font: face,
            color: if style.link { blue_900() } else { color },
            background_color: None,
            underline: None,
            strikethrough: style.strike.then_some(StrikethroughStyle {
                thickness: px(1.),
                color: None,
            }),
        });
    }

    fn inline(&mut self, nodes: &[Node], style: Inline, color: Hsla) {
        for node in nodes {
            match node {
                Node::Text(t) => self.push(&t.value.replace('\n', " "), style, color),
                Node::Strong(n) => self.inline(
                    &n.children,
                    Inline {
                        bold: true,
                        ..style
                    },
                    color,
                ),
                Node::Emphasis(n) => self.inline(
                    &n.children,
                    Inline {
                        italic: true,
                        ..style
                    },
                    color,
                ),
                Node::Delete(n) => self.inline(
                    &n.children,
                    Inline {
                        strike: true,
                        ..style
                    },
                    color,
                ),
                Node::InlineCode(n) => self.push(
                    &n.value,
                    Inline {
                        code: true,
                        ..style
                    },
                    color,
                ),
                Node::Link(n) => {
                    let start = self.text.len();
                    self.inline(
                        &n.children,
                        Inline {
                            link: true,
                            ..style
                        },
                        color,
                    );
                    self.links.push((start..self.text.len(), n.url.clone()));
                }
                Node::Break(_) => self.push("\n", style, color),
                Node::Html(n) => self.push(&n.value, style, color),
                Node::Image(n) => self.push(&n.alt, style, color),
                other => {
                    if let Some(children) = other.children() {
                        self.inline(children, style, color);
                    }
                }
            }
        }
    }
}

struct Renderer {
    turn: usize,
    next: usize,
    compact: bool,
}

impl Renderer {
    fn id(&mut self, name: &'static str) -> (&'static str, usize) {
        self.next += 1;
        (name, self.turn * 10_000 + self.next)
    }

    fn body(&self) -> gpui_kit::Div {
        if self.compact {
            text(13., 20.)
        } else {
            text(14., 24.)
        }
    }

    fn line(&mut self, nodes: &[Node], style: Inline, color: Hsla) -> Option<AnyElement> {
        let mut line = Line::default();
        line.inline(nodes, style, color);
        if line.text.trim().is_empty() {
            return None;
        }
        let styled = StyledText::new(line.text).with_runs(line.runs);
        if line.links.is_empty() {
            return Some(styled.into_any_element());
        }
        let (ranges, urls): (Vec<_>, Vec<_>) = line.links.into_iter().unzip();
        Some(
            InteractiveText::new(self.id("md-link"), styled)
                .on_click(ranges, move |i, _, cx| cx.open_url(&urls[i]))
                .into_any_element(),
        )
    }

    fn blocks(&mut self, nodes: &[Node], color: Hsla) -> Vec<AnyElement> {
        let mut out = Vec::new();
        for node in nodes {
            let first = out.is_empty();
            if let Some(el) = self.block(node, color, first) {
                out.push(el);
            }
        }
        out
    }

    fn block(&mut self, node: &Node, color: Hsla, first: bool) -> Option<AnyElement> {
        match node {
            Node::Paragraph(n) => {
                let line = self.line(&n.children, Inline::default(), color)?;
                Some(self.body().child(line).into_any_element())
            }
            Node::Heading(n) => {
                let (size, lead, space) = match n.depth {
                    1 => (20., 28., 10.),
                    2 => (16., 24., 10.),
                    _ => (14., 22., 6.),
                };
                let line = self.line(
                    &n.children,
                    Inline {
                        bold: true,
                        ..Inline::default()
                    },
                    gray_1000(),
                )?;
                Some(
                    text(size, lead)
                        .when(!first, |d| d.pt(px(space)))
                        .child(line)
                        .into_any_element(),
                )
            }
            Node::List(n) => {
                let start = n.start.unwrap_or(1) as usize;
                let items: Vec<AnyElement> = n
                    .children
                    .iter()
                    .enumerate()
                    .filter_map(|(i, item)| {
                        let children = self.blocks(item.children()?, color);
                        let marker = if n.ordered {
                            text(12., if self.compact { 20. } else { 24. })
                                .w(px(18.))
                                .flex_shrink_0()
                                .font_family(MONO)
                                .text_color(gray_700())
                                .child(format!("{}.", start + i))
                        } else {
                            self.body()
                                .flex_shrink_0()
                                .text_color(gray_700())
                                .child("•")
                        };
                        Some(
                            div()
                                .flex()
                                .gap(px(10.))
                                .child(marker)
                                .child(v_flex().flex_1().min_w_0().gap(px(6.)).children(children))
                                .into_any_element(),
                        )
                    })
                    .collect();
                Some(
                    v_flex()
                        .gap(px(6.))
                        .pl(px(4.))
                        .children(items)
                        .into_any_element(),
                )
            }
            Node::Code(n) => Some(self.code(n.lang.as_deref(), &n.value)),
            Node::Blockquote(n) => {
                let children = self.blocks(&n.children, gray_900());
                Some(
                    div()
                        .flex()
                        .gap(px(12.))
                        .child(
                            div()
                                .w(px(2.))
                                .flex_shrink_0()
                                .rounded(px(1.))
                                .bg(gray_500()),
                        )
                        .child(v_flex().flex_1().min_w_0().gap(px(8.)).children(children))
                        .into_any_element(),
                )
            }
            Node::ThematicBreak(_) => Some(
                div()
                    .h(px(1.))
                    .my(px(6.))
                    .bg(alpha_200())
                    .into_any_element(),
            ),
            Node::Table(n) => Some(self.table(&n.children)),
            Node::Html(n) => Some(
                self.body()
                    .text_color(color)
                    .child(n.value.clone())
                    .into_any_element(),
            ),
            _ => None,
        }
    }

    fn code(&mut self, lang: Option<&str>, value: &str) -> AnyElement {
        let value = value.trim_end_matches('\n');
        let copy = value.to_string();
        v_flex()
            .rounded(px(10.))
            .border_1()
            .border_color(alpha_300())
            .child(
                h_flex()
                    .h(px(34.))
                    .flex_shrink_0()
                    .pl(px(14.))
                    .pr(px(8.))
                    .gap(px(8.))
                    .rounded_t(px(9.))
                    .bg(gray_100())
                    .child(
                        text(12., 16.)
                            .flex_1()
                            .font_family(MONO)
                            .text_color(gray_900())
                            .child(lang.unwrap_or("text").to_string()),
                    )
                    .child(
                        h_flex()
                            .id(self.id("md-copy"))
                            .h(px(24.))
                            .px(px(8.))
                            .gap(px(6.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|d| d.bg(alpha_200()))
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))
                            })
                            .child(icon("copy", 12., gray_900()))
                            .child(text(12., 16.).text_color(gray_900()).child("Copy")),
                    ),
            )
            .child(
                v_flex()
                    .id(self.id("md-code"))
                    .overflow_x_scroll()
                    .px(px(14.))
                    .py(px(12.))
                    .rounded_b(px(9.))
                    .bg(background_200())
                    .font_family(MONO)
                    .text_size(px(12.))
                    .line_height(px(20.))
                    .children({
                        let colors = highlights(lang, value);
                        let mut start = 0;
                        value.split('\n').map(move |l| {
                            let line = start..start + l.len();
                            start = line.end + 1;
                            let own: Vec<(Range<usize>, HighlightStyle)> = colors
                                .iter()
                                .filter(|(r, _)| r.start < line.end && r.end > line.start)
                                .map(|(r, style)| {
                                    (
                                        r.start.max(line.start) - line.start
                                            ..r.end.min(line.end) - line.start,
                                        *style,
                                    )
                                })
                                .filter(|(r, _)| {
                                    l.is_char_boundary(r.start) && l.is_char_boundary(r.end)
                                })
                                .collect();
                            div()
                                .whitespace_nowrap()
                                .min_h(px(20.))
                                .child(StyledText::new(l.to_string()).with_highlights(own))
                        })
                    }),
            )
            .into_any_element()
    }

    fn table(&mut self, rows: &[Node]) -> AnyElement {
        let mut out = v_flex()
            .rounded(px(10.))
            .border_1()
            .border_color(alpha_300());
        for (r, row) in rows.iter().enumerate() {
            let head = r == 0;
            let cells: Vec<AnyElement> = row
                .children()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|cell| {
                    let color = if head { gray_900() } else { gray_1000() };
                    let line = cell
                        .children()
                        .and_then(|c| self.line(c, Inline::default(), color));
                    if head { text(12., 16.) } else { text(13., 20.) }
                        .flex_1()
                        .min_w_0()
                        .children(line)
                        .into_any_element()
                })
                .collect();
            out = out.child(
                h_flex()
                    .min_h(px(if head { 34. } else { 38. }))
                    .px(px(14.))
                    .py(px(if head { 0. } else { 8. }))
                    .gap(px(12.))
                    .when(head, |d| d.rounded_t(px(9.)).bg(gray_100()))
                    .when(!head, |d| d.border_t_1().border_color(alpha_200()))
                    .children(cells),
            );
        }
        out.into_any_element()
    }
}

fn render(turn: usize, salt: usize, source: &str, compact: bool, color: Hsla) -> AnyElement {
    let mut renderer = Renderer {
        turn,
        next: salt * 100,
        compact,
    };
    let blocks = match &*parsed(source) {
        Some(Node::Root(root)) => renderer.blocks(&root.children, color),
        _ => vec![renderer.body().child(source.to_string()).into_any_element()],
    };
    v_flex()
        .gap(px(if compact { 6. } else { 14. }))
        .text_color(color)
        .children(blocks)
        .into_any_element()
}

pub fn answer(turn: usize, source: &str) -> AnyElement {
    render(turn, 0, source, false, gray_1000())
}

pub fn narration(turn: usize, step: usize, source: &str, color: Hsla) -> AnyElement {
    render(turn, step + 1, source, true, color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_coloured_by_its_grammar() {
        let code = "def greet(name):\n    print(\"hi\")\n";
        let colors = highlights(Some("python"), code);
        let color_of = |word: &str| {
            let at = code.find(word).unwrap();
            colors
                .iter()
                .find(|(r, _)| r.start <= at && at < r.end)
                .and_then(|(_, style)| style.color)
        };
        assert_eq!(color_of("def"), Some(pink_900()));
        assert_eq!(color_of("\"hi\""), Some(green_900()));
        assert_eq!(color_of("greet"), Some(purple_900()));
        assert!(highlights(None, code).is_empty());
        assert!(
            highlights(Some("nosuchlang"), code)
                .iter()
                .all(|(_, style)| style.color.is_none())
        );
    }

    #[test]
    fn inline_runs_cover_the_text_and_keep_links() {
        let tree = markdown::to_mdast(
            "Read `main.py`, **then** see [the notes](https://x.dev).",
            &markdown::ParseOptions::gfm(),
        )
        .unwrap();
        let Node::Root(root) = tree else {
            panic!("no root")
        };
        let Node::Paragraph(p) = &root.children[0] else {
            panic!("no paragraph")
        };
        let mut line = Line::default();
        line.inline(&p.children, Inline::default(), gray_1000());
        assert_eq!(line.text, "Read main.py, then see the notes.");
        assert_eq!(
            line.runs.iter().map(|r| r.len).sum::<usize>(),
            line.text.len()
        );
        assert_eq!(line.runs[1].font.family.as_ref(), MONO);
        assert_eq!(line.runs[3].font.weight, FontWeight::SEMIBOLD);
        let (range, url) = &line.links[0];
        assert_eq!(&line.text[range.clone()], "the notes");
        assert_eq!(url, "https://x.dev");
    }
}
