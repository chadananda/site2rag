---
url: "https://bahai-education.org/categories"
timestamp: "2025-06-23T16:59:40.021Z"
content_length: 112
original_length: 13828
reduction_percent: 99.19
---

# Debug Report for https://bahai-education.org/categories

## Content Statistics

- **Original Length:** 13828 characters
- **Content Length:** 112 characters
- **Reduction:** 99.19%

## Selector Decisions

| Selector | Decision | Reason | Content Preview |
| --- | --- | --- | --- |
| header.astronav-sticky-header.sticky.top-0.border-b.transition-all.z-50.py-5.border-transparent > div.mx-auto.px-5 > div.flex.flex-col.sm:flex-row.justify-between.items-center.relative.z-10 > div.flex.w-full.sm:w-auto.items-center.justify-between > div#logo.flex.items-center > nav | identify | Navigation element | Error getting preview |
| div.mx-auto.px-5 > main.flex.flex-wrap.justify-center.gap-20.mt-5.pb-40 | identify | Semantic main element |  |
| header.astronav-sticky-header.sticky.top-0.border-b.transition-all.z-50.py-5.border-transparent | identify | Semantic header element |  |
| footer.py-8.bg-slate-100.border-t.border-slate-100.noprint.mt-10 | identify | Semantic footer element |  |
| header.astronav-sticky-header | remove | Navigation or boilerplate element |  |
| script | remove | Non-content element: script | window.va = window.va \|\| funct... |
| div.mx-auto | remove | Navigation or boilerplate element |  |
| footer.py-8 | remove | Navigation or boilerplate element |  |
| vercel-speed-insights | remove | Empty element |  |
| --phase-separator-- | info | Above: Initial boilerplate removal | Below: Content classification |  |

## Kept Content

```html
    <!-- <div class:list={["max-w-screen-xl mx-auto px-5", className]}> -->     <!-- <ViewTransitions /> -->    
```

## Removed Content (Sample)

```html
<header class="astronav-sticky-header sticky top-0 border-b transition-all z-50 py-5 border-transparent">  <!-- <div class:list={["max-w-screen-xl mx-auto px-5", className]}> --><div class="mx-auto px-5">  <div class="flex flex-col sm:flex-row justify-between items-center relative z-10" data-astro-transition-scope="astro-o7bz76pi-4">  <div class="flex w-full sm:w-auto items-center justify-between"> <div id="logo" class="flex items-center"> <nav data-astro-cid-7em3fxft=""> <a href="/" aria-label="Bahai-education.org" class="sitelogo flex items-center no-underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-300 focus-visible:outline-none focus-visible:shadow-outline-indigo rounded-full" data-astro-cid-7em3fxft=""> <img src="/favicon.svg" alt="Bahai-education.org Logo" width="40" height="40" class="h-10 opacity-75 m-0 pr-2" data-astro-cid-7em3fxft=""> <span class="sr-only" data-astro-cid-7em3fxft="">Bahai-education.org</span> <span class="text-lg  xs:inline" data-astro-cid-7em3fxft=""> <span class="logofirst font-bold greenish" data-astro-cid-7em3fxft="">Bahai</span>-<span class="text-slate-600" data-astro-cid-7em3fxft="">education</span><span class="font-bold greenish" data-astro-cid-7em3fxft="">.org</span> </span> </a> </nav>  </div> <div class="block sm:hidden"> <button id="astronav-menu" aria-label="Toggle Menu">  <svg fill="currentColor" class="w-4 h-4 text-gray-800" width="24" height="24" viewBox="0 0 24 24" xmlns="https://www.w3.org/2000/svg"> <title>Toggle Menu</title> <path class="astronav-close-icon astronav-toggle hidden" fill-rule="evenodd" clip-rule="evenodd" d="M18.278 16.864a1 1 0 01-1.414 1.414l-4.829-4.828-4.828 4.828a1 1 0 01-1.414-1.414l4.828-4.829-4.828-4.828a1 1 0 011.414-1.414l4.829 4.828 4.828-4.828a1 1 0 111.414 1.414l-4.828 4.829 4.828 4.828z"></path> <path class="astronav-open-icon astronav-toggle" fill-rule="evenodd" d="M4 5h16a1 1 0 010 2H4a1 1 0 110-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2zm0 6h16a1 1 0 010 2H4a1 1 0 010-2z"></path> </svg>  </button> </div> </div> <nav class="astronav-items astronav-toggle hidden w-full sm:w-auto mt-2 sm:flex sm:mt-0 noprint">  <ul class="flex flex-col sm:flex-row sm:gap-3"> <li> <a href="/categories" aria-label="Categories" data-astro-reload="" class="flex sm:px-3 py-2 text-sm text-gray-600 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-offset-2 transition focus-visible:ring-indigo-500 focus-visible:outline-none focus-visible:shadow-outline-indigo rounded-full"> Categories </a> </li><li> <a href="/topics" aria-label="Topics" data-astro-reload="" class="flex sm:px-3 py-2 text-sm text-gray-600 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-offset-2 transition focus-visible:ring-indigo-500 focus-visible:outline-none focus-visible:shadow-outline-indigo rounded-full"> Topics </a> </li><li> <a href="/contact" aria-label="Contact" data-astro-reload="" class="flex sm:px-3 py-2 text-sm text-gray-600 hover:text-indigo-600 focus-visible:ring-2 focus-visible:ring-offset-2 transition focus-visible:ring-indigo-500 focus-visible:outline-none focus-visible:shadow-outline-indigo rounded-full"> Contact </a> </li> </ul>  </nav>  <script>(function(){const closeOnClick = false;

["DOMContentLoaded", "astro:after-swap"].forEach((event) => {
  document.addEventListener(event, addListeners);
});

// Function to clone and replace elements
function cloneAndReplace(element) {
  const clone = element.cloneNode(true);
  element.parentNode.replaceChild(clone, element);
}

function addListeners() {
  // Clean up existing listeners
  const oldMenuButton = document.getElementById("astronav-menu");
  if (oldMenuButton) {
    cloneAndReplace(oldMenuButton);
  }

  const oldDropdownMenus = document.querySelectorAll(".astronav-dropdown");
  oldDropdownMenus.forEach((menu) => {
    cloneAndReplace(menu);
  });

  // Mobile nav toggle
  const menuButton = document.getElementById("astronav-menu");
  menuButton && menuButton.addEventListener("click", toggleMobileNav);

  // Dropdown menus
  const dropdownMenus = document.querySelectorAll(".astronav-dropdown");
  dropdownMenus.forEach((menu) => {
    const button = menu.querySelector("button");
    button &&
      button.addEventListener("click", (event) =>
        toggleDropdownMenu(event, menu, dropdownMenus)
      );

    // Handle Submenu Dropdowns
    const dropDownSubmenus = menu.querySelectorAll(
      ".astronav-dropdown-submenu"
    );

    dropDownSubmenus.forEach((submenu) => {
      const submenuButton = submenu.querySelector("button");
      submenuButton &&
        submenuButton.addEventListener("click", (event) => {
          event.stopImmediatePropagation();
          toggleSubmenuDropdown(event, submenu);
        });
    });
  });

  // Clicking away from dropdown will remove the dropdown class
  document.addEventListener("click", closeAllDropdowns);

  if (closeOnClick) {
    handleCloseOnClick();
  }
}

function toggleMobileNav() {
  [...document.querySelectorAll(".a... (truncated)
```
