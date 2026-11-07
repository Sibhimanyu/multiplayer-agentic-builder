/* The "Share a session" sequence on index.html.

   The HTML is the story's FINAL state. This file only rewinds it to the start and scrubs it
   forward with the scroll, so:
   - no script, or GSAP failing to load from the CDN: the final state renders, fully readable;
   - prefers-reduced-motion: nothing here runs, the final state renders;
   - everything animated is opacity or a transform, so no step reflows the page.
   gsap.matchMedia() reverts every set() and ScrollTrigger below when its query stops matching,
   which is how a resize across the pin breakpoint (or turning reduced motion on) gets back to
   the static final state without bookkeeping here. */
(function () {
  'use strict';
  var root = document.getElementById('share');
  if (!root || !window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);

  function all(sel) { return gsap.utils.toArray(root.querySelectorAll(sel)); }
  function one(sel) { return root.querySelector(sel); }

  var mm = gsap.matchMedia();
  mm.add({
    motion: '(prefers-reduced-motion: no-preference)',
    // Pin only where the whole stage fits under the nav. Below this the deck is CSS-sticky
    // instead and the sequence plays as the terminals scroll past.
    roomy: '(min-width: 960px) and (min-height: 700px)'
  }, function (ctx) {
    if (!ctx.conditions.motion) return;
    var pinned = ctx.conditions.roomy;

    var story = all('.ss-story li');
    var rail = one('.ss-rail i');
    var slide2 = one('[data-slide="2"] .sl-face');
    var mine = all('.slide.mine .sl-face');
    var seat = one('.ss-seat');
    var req = one('.req');
    var msg = one('.msg');
    var lines = function (n) { return all('.ln[data-step="' + n + '"]'); };

    // ---- the start of the story ----
    gsap.set(all('.ln[data-step]'), { autoAlpha: 0, x: -6 });
    gsap.set(seat, { autoAlpha: 0, scale: 1.04 });
    gsap.set(one('.sl-title .typo'), { autoAlpha: 1 });
    gsap.set(one('.sl-title .fixed'), { autoAlpha: 0 });
    gsap.set(all('[data-slide="2"] .sl-state > *, [data-slide="2"] .sl-ring'), { autoAlpha: 0 });
    gsap.set(req, { autoAlpha: 0, x: 48 });
    gsap.set(all('.req .st-open, .req .edge.open'), { autoAlpha: 1 });
    gsap.set(all('.req .st-done, .req .edge.done'), { autoAlpha: 0 });
    gsap.set(msg, { autoAlpha: 0, x: 48 });
    if (pinned) {
      gsap.set(story, { opacity: 0.32 });
      gsap.set(rail, { scaleY: 0 });
    }

    var tl = gsap.timeline({
      defaults: { duration: 0.6, ease: 'power2.out' },
      scrollTrigger: pinned ? {
        trigger: one('.ss-pin'),
        start: 'top top+=86',          // below the sticky nav
        end: '+=3000',
        pin: true,
        scrub: 0.6,
        anticipatePin: 1,
        invalidateOnRefresh: true
      } : {
        trigger: one('.ss-stage'),
        start: 'top 72%',
        end: 'bottom 70%',
        scrub: 0.6,
        invalidateOnRefresh: true
      }
    });

    // One step = its caption lights, its terminal lines type in, then the stage changes.
    function step(n, change) {
      var at = 's' + n;
      tl.addLabel(at);
      if (pinned) {
        tl.to(story[n], { opacity: 1, duration: 0.3 }, at);
        if (n > 0) tl.to(story[n - 1], { opacity: 0.55, duration: 0.3 }, at);
      }
      tl.to(lines(n), { autoAlpha: 1, x: 0, duration: 0.35, stagger: 0.18 }, at);
      if (change) change(at + '+=0.2');
      tl.to({}, { duration: 0.5 });   // a beat to read before the next step
    }

    step(0, function (at) {
      tl.to(seat, { autoAlpha: 1, scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, at)
        .fromTo(mine, { y: 0 }, { y: -4, duration: 0.2, stagger: 0.06, yoyo: true, repeat: 1,
          ease: 'sine.inOut' }, at);
    });
    step(1);
    step(2, function (at) {
      tl.to(all('[data-slide="2"] .sl-ring.refused, [data-slide="2"] .st-refused'),
        { autoAlpha: 1, duration: 0.25 }, at)
        .to(slide2, { keyframes: { x: [0, -5, 5, -3, 3, 0] }, duration: 0.5, ease: 'none' }, at);
    });
    step(3, function (at) {
      tl.to(req, { autoAlpha: 1, x: 0, duration: 0.6 }, at);
    });
    step(4, function (at) {
      tl.to(all('.req .st-open, .req .edge.open'), { autoAlpha: 0, duration: 0.25 }, at)
        .to(all('.req .st-done, .req .edge.done'), { autoAlpha: 1, duration: 0.25 }, at)
        .to(all('[data-slide="2"] .sl-ring.refused, [data-slide="2"] .st-refused'),
          { autoAlpha: 0, duration: 0.25 }, at)
        .to(all('[data-slide="2"] .sl-ring.granted, [data-slide="2"] .st-granted'),
          { autoAlpha: 1, duration: 0.25 }, at)
        .to(one('.sl-title .typo'), { autoAlpha: 0, duration: 0.3 }, at + '+=0.4')
        .to(one('.sl-title .fixed'), { autoAlpha: 1, duration: 0.3 }, '<');
    });
    step(5, function (at) {
      tl.to(all('[data-slide="2"] .sl-ring.granted, [data-slide="2"] .st-granted'),
        { autoAlpha: 0, duration: 0.25 }, at)
        .to(one('[data-slide="2"] .st-locked'), { autoAlpha: 1, duration: 0.25 }, at);
    });
    step(6, function (at) {
      // The message leaves Priya's pane and lands with Sam: the card travels right to left.
      tl.to(msg, { autoAlpha: 1, x: 0, duration: 0.7 }, at);
    });

    if (pinned) tl.to(rail, { scaleY: 1, ease: 'none', duration: tl.duration() }, 0);
    tl.to({}, { duration: 0.6 });

  });

  // The template tiles: a small rise as they enter. Final state is the CSS default.
  mm.add('(prefers-reduced-motion: no-preference)', function () {
    var tiles = gsap.utils.toArray(root.querySelectorAll('.tpl'));
    gsap.set(tiles, { autoAlpha: 0, y: 18 });
    ScrollTrigger.batch(tiles, {
      start: 'top 88%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { autoAlpha: 1, y: 0, duration: 0.6, ease: 'power2.out', stagger: 0.1 });
      }
    });
  });

  // Plex arrives with font-display:swap and changes line heights; re-measure once it has.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { ScrollTrigger.refresh(); });
  }
})();
