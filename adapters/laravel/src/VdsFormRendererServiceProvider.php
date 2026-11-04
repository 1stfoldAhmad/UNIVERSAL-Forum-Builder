<?php
/**
 * Laravel 13 service provider. Registers the renderer singleton, a @vdsForm
 * Blade directive, and publishes nothing by default. Illuminate is only
 * referenced here inside a host app; the renderer core is framework-free.
 */
declare(strict_types=1);

namespace VdsForm\Renderer;

use Illuminate\Support\ServiceProvider;

final class VdsFormRendererServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(RenderController::class, fn() => new RenderController());
        $this->app->singleton('vds-form.renderer', fn() => new RenderController());
    }

    public function boot(): void
    {
        if (class_exists(\Illuminate\Support\Facades\Blade::class)) {
            \Illuminate\Support\Facades\Blade::directive('vdsForm', function ($expression) {
                return "<?php echo \\VdsForm\\Renderer\\Renderer::renderForm($expression); ?>";
            });
        }
        $this->loadViewsFrom(__DIR__ . '/../resources/views', 'vds-form');
    }
}
