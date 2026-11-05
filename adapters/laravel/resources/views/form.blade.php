{{--
  Published Blade view for the VDS form renderer.

  Usage in a host Laravel 13 app:
      @include('vds-form::form', ['ir' => $ir, 'opts' => ['action' => '/forms/contact']])

  Or use the directive directly:
      @vdsForm($ir, ['action' => '/forms/contact'])

  The renderer emits the shared server-rendered HTML contract. CSRF is supplied
  by the host app's session; identity is always derived server-side.
--}}
{!! \VdsForm\Renderer\Renderer::renderForm($ir, $opts ?? []) !!}
